'use strict';

/**
 * Verifies the PostgreSQL path WITHOUT needing a Neon account.
 *
 *   npm run test:postgres
 *
 * PGlite is a real PostgreSQL engine compiled to WebAssembly, so it accepts (and
 * rejects) exactly the same SQL that Neon does. This catches dialect mistakes -
 * IDENTITY columns, ON CONFLICT, RETURNING, BIGINT coming back as a string -
 * before anything is deployed, rather than after.
 *
 * It exercises the real schema file and the real placeholder translation used
 * by src/db/index.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const SCHEMA_FILE = path.join(__dirname, '..', 'src', 'db', 'schema.postgres.sql');

const results = [];
let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    results.push(`  [PASS] ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failed += 1;
    results.push(`  [FAIL] ${label}${detail ? `  (${detail})` : ''}`);
  }
}

/** The exact placeholder translation from src/db/index.js. */
function toPositional(sql) {
  let index = 0;
  let inString = false;
  let output = '';

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "'") {
      inString = !inString;
      output += char;
      continue;
    }
    if (char === '?' && !inString) {
      index += 1;
      output += '$' + index;
      continue;
    }
    output += char;
  }
  return output;
}

/** The exact statement splitting from the Postgres adapter. */
function splitStatements(sqlText) {
  return sqlText
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function run() {
  const pg = new PGlite();
  const q = async (sql, params = []) => (await pg.query(toPositional(sql), params)).rows;
  const iso = () => new Date().toISOString();

  console.log('\n  Running PostgreSQL dialect tests (PGlite, real Postgres in WASM)\n');

  // --- schema ------------------------------------------------------------
  const statements = splitStatements(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  for (const statement of statements) {
    await pg.exec(statement);
  }

  const tables = (
    await pg.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
  ).rows.map((r) => r.tablename);

  check('Schema applies cleanly to PostgreSQL', tables.length === 4, tables.join(', '));
  check('users table created', tables.includes('users'));
  check('mfa_sessions table created', tables.includes('mfa_sessions'));
  check('auth_events table created', tables.includes('auth_events'));
  check('user_sessions table created', tables.includes('user_sessions'));

  // --- users: INSERT ... RETURNING (identity column) ----------------------
  const user = (
    await q(
      `INSERT INTO users (name, email, password_hash, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?) RETURNING *`,
      ['Aman Gupta', 'aman@example.com', '$2b$12$fakehash', iso(), iso()]
    )
  )[0];

  check('INSERT ... RETURNING gives the generated id', typeof user.id === 'number' && user.id > 0, `id=${user.id}`);
  check('Identity column auto-increments', user.id === 1);

  // --- unique constraint --------------------------------------------------
  let duplicateRejected = false;
  try {
    await q(
      `INSERT INTO users (name, email, password_hash, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
      ['Copy', 'aman@example.com', 'x', iso(), iso()]
    );
  } catch (error) {
    duplicateRejected = true;
  }
  check('UNIQUE(email) blocks a duplicate account', duplicateRejected);

  // --- mfa_sessions -------------------------------------------------------
  const sessionId = 'a'.repeat(64);
  const session = (
    await q(
      `INSERT INTO mfa_sessions
         (id, user_id, password_verified, status, ip_address, user_agent, created_at, updated_at, expires_at)
       VALUES (?, ?, 1, 'pending', ?, ?, ?, ?, ?) RETURNING *`,
      [sessionId, user.id, '127.0.0.1', 'test', iso(), iso(), new Date(Date.now() + 600000).toISOString()]
    )
  )[0];

  check('MFA session row inserted', session.id === sessionId);
  check('Integer flags behave like booleans', session.password_verified === 1 && session.otp_verified === 0);
  check('Column defaults applied', session.otp_attempts === 0 && session.status === 'pending');

  // --- UPDATE ... RETURNING with many placeholders ------------------------
  const updated = (
    await q(
      `UPDATE mfa_sessions SET otp_hash = ?, otp_expires_at = ?, otp_attempts = 0, otp_verified = 0,
              otp_last_sent_at = ?, otp_resend_count = ?, updated_at = ? WHERE id = ? RETURNING *`,
      ['$2b$10$otphash', new Date(Date.now() + 300000).toISOString(), iso(), 0, iso(), sessionId]
    )
  )[0];
  check('UPDATE ... RETURNING returns the new row', updated.otp_hash === '$2b$10$otphash');

  // --- increment ----------------------------------------------------------
  const bumped = (
    await q('UPDATE mfa_sessions SET otp_attempts = otp_attempts + 1, updated_at = ? WHERE id = ? RETURNING *', [
      iso(),
      sessionId,
    ])
  )[0];
  check('Attempt counter increments', bumped.otp_attempts === 1);

  // --- foreign key --------------------------------------------------------
  let fkRejected = false;
  try {
    await q(
      `INSERT INTO mfa_sessions (id, user_id, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['b'.repeat(64), 99999, iso(), iso(), iso()]
    );
  } catch (error) {
    fkRejected = true;
  }
  check('Foreign key rejects an unknown user_id', fkRejected);

  // --- timestamp comparison as TEXT --------------------------------------
  const expiredRows = await q(
    "DELETE FROM mfa_sessions WHERE expires_at <= ? AND status <> 'completed' RETURNING id",
    [new Date(Date.now() - 60000).toISOString()]
  );
  check('ISO text timestamps compare correctly', expiredRows.length === 0, 'nothing expired yet');

  const allExpired = await q(
    "DELETE FROM mfa_sessions WHERE expires_at <= ? AND status <> 'completed' RETURNING id",
    [new Date(Date.now() + 3600000).toISOString()]
  );
  check('DELETE ... RETURNING reports the deleted count', allExpired.length === 1, `${allExpired.length} row(s)`);

  // --- auth_events --------------------------------------------------------
  await q(
    `INSERT INTO auth_events (user_id, mfa_session_id, event, detail, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [user.id, sessionId, 'MFA_COMPLETED', null, '127.0.0.1', iso()]
  );
  const events = await q('SELECT event, detail, created_at FROM auth_events WHERE user_id = ? ORDER BY id DESC LIMIT ?', [
    user.id,
    8,
  ]);
  check('LIMIT accepts a bound parameter', events.length === 1, events[0].event);

  // --- session store: upsert ---------------------------------------------
  const expiry = Date.now() + 1200000;
  await q(
    `INSERT INTO user_sessions (sid, data, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
    ['sid-1', JSON.stringify({ a: 1 }), expiry]
  );
  await q(
    `INSERT INTO user_sessions (sid, data, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
    ['sid-1', JSON.stringify({ a: 2 }), expiry]
  );

  const stored = await q('SELECT data, expires_at FROM user_sessions WHERE sid = ?', ['sid-1']);
  check('ON CONFLICT upsert replaces the row', stored.length === 1 && JSON.parse(stored[0].data).a === 2);

  // BIGINT is returned as a string by the Postgres wire protocol - the store
  // wraps it in Number(), which is what this asserts is still necessary.
  const rawExpiry = stored[0].expires_at;
  check(
    'BIGINT expiry survives Number() conversion',
    Number(rawExpiry) === expiry,
    `driver returned ${typeof rawExpiry}`
  );

  // --- COUNT(*) comes back as a string too --------------------------------
  const countRow = (await q('SELECT COUNT(*) AS total FROM user_sessions WHERE expires_at > ?', [Date.now()]))[0];
  check('COUNT(*) survives Number() conversion', Number(countRow.total) === 1, `driver returned ${typeof countRow.total}`);

  // --- report -------------------------------------------------------------
  console.log(results.join('\n'));
  console.log('\n  ' + '='.repeat(60));
  console.log(`  Passed: ${passed}   Failed: ${failed}   Total: ${passed + failed}`);
  console.log('  ' + '='.repeat(60) + '\n');

  await pg.close();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.log(results.join('\n'));
  console.error('\n  PostgreSQL dialect test crashed:', error.message);
  console.error(error.stack);
  process.exit(1);
});
