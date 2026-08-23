'use strict';

/**
 * Database bootstrap script.
 *   npm run init-db    -> create tables if they do not exist
 *   npm run reset-db   -> drop everything and start from a clean database
 *
 * Works against whichever database is configured: the local SQLite file, or
 * Neon Postgres when DATABASE_URL is set.
 */

const db = require('./index');

async function main() {
  const shouldReset = process.argv.includes('--reset');

  console.log('');
  console.log(`  Database: ${db.driver} (${db.location})`);

  if (shouldReset) {
    // Order matters: children before parents, because of the foreign keys.
    for (const table of ['user_sessions', 'auth_events', 'mfa_sessions', 'users']) {
      await db.exec(`DROP TABLE IF EXISTS ${table} CASCADE;`.replace(' CASCADE', db.isPostgres ? ' CASCADE' : ''));
    }
    console.log('  All tables dropped.');
  }

  await db.migrate();

  const rows = db.isPostgres
    ? await db.all(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
      )
    : await db.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );

  console.log(`  Tables: ${rows.map((row) => row.name).join(', ')}`);
  console.log('');

  await db.close();
}

main().catch((error) => {
  console.error('\n  Database setup failed:', error.message, '\n');
  process.exit(1);
});
