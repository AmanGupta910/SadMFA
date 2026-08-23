'use strict';

/**
 * Database access layer.
 *
 * The project runs against two different databases:
 *
 *   SQLite   (default)  - a local file. Zero setup, used for development and
 *                         for the automated tests.
 *   Postgres (Neon)     - used when DATABASE_URL is set, which is how it runs
 *                         on Vercel. Serverless functions have no persistent
 *                         disk and each request may land on a different
 *                         instance, so a database file cannot be used there.
 *
 * Everything above this file talks to one small async API (`all`, `get`, `run`)
 * and writes SQL with `?` placeholders. The Postgres adapter rewrites those to
 * $1, $2, ... so the queries themselves stay identical for both engines.
 */

const fs = require('node:fs');
const path = require('node:path');

const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_POSTGRES = DATABASE_URL.length > 0;

const SCHEMA_FILE = path.join(__dirname, USE_POSTGRES ? 'schema.postgres.sql' : 'schema.sql');

/** Current UTC timestamp in ISO-8601 - the format every date column uses. */
const now = () => new Date().toISOString();

/**
 * Rewrites `?` placeholders into Postgres `$1, $2, ...` form.
 * Question marks inside string literals are left alone.
 */
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

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function createSqliteAdapter() {
  const { DatabaseSync } = require('node:sqlite');

  /**
   * Where the database file lives. DATA_DIR lets a deployment point this at a
   * mounted persistent disk instead of the project folder.
   */
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', '..', 'data');

  fs.mkdirSync(dataDir, { recursive: true });

  const file = path.join(dataDir, 'gocart-mfa.db');
  const db = new DatabaseSync(file);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  return {
    driver: 'sqlite',
    location: file,
    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async get(sql, params = []) {
      return db.prepare(sql).get(...params) || null;
    },
    async run(sql, params = []) {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
    async exec(sqlText) {
      db.exec(sqlText);
    },
    async close() {
      db.close();
    },
  };
}

function createPostgresAdapter() {
  const { neon } = require('@neondatabase/serverless');

  // The HTTP driver opens no long-lived socket, which is what a serverless
  // function needs: there is no connection pool to exhaust between invocations.
  const sql = neon(DATABASE_URL);

  const run = async (text, params) => sql.query(toPositional(text), params);

  return {
    driver: 'postgres',
    location: 'neon (DATABASE_URL)',
    async all(text, params = []) {
      return run(text, params);
    },
    async get(text, params = []) {
      const rows = await run(text, params);
      return rows.length > 0 ? rows[0] : null;
    },
    async run(text, params = []) {
      const rows = await run(text, params);
      return {
        changes: Array.isArray(rows) ? rows.length : 0,
        lastInsertId: rows && rows[0] && rows[0].id !== undefined ? rows[0].id : null,
      };
    },
    async exec(sqlText) {
      // Neon's HTTP endpoint accepts a single statement per call, so a schema
      // script has to be split up and replayed statement by statement.
      //
      // Comment lines are stripped BEFORE splitting. Splitting first would be
      // wrong: every CREATE TABLE here sits under a banner of `--` comments, so
      // the resulting chunk starts with `--` and a naive "skip comments" filter
      // would silently throw the table away.
      const withoutComments = sqlText
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');

      const statements = withoutComments
        .split(';')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);

      for (const statement of statements) {
        await sql.query(statement);
      }
    },
    async close() {
      /* nothing to close - the HTTP driver is stateless */
    },
  };
}

const adapter = USE_POSTGRES ? createPostgresAdapter() : createSqliteAdapter();

// ---------------------------------------------------------------------------
// Migration
//
// Cached as a single promise: on a serverless platform every cold start would
// otherwise re-run the schema, and concurrent requests would race each other.
// ---------------------------------------------------------------------------
let migrationPromise = null;

function migrate() {
  if (!migrationPromise) {
    migrationPromise = adapter.exec(fs.readFileSync(SCHEMA_FILE, 'utf8')).catch((error) => {
      migrationPromise = null; // let the next request retry rather than wedging
      throw error;
    });
  }
  return migrationPromise;
}

module.exports = {
  all: (sql, params) => adapter.all(sql, params),
  get: (sql, params) => adapter.get(sql, params),
  run: (sql, params) => adapter.run(sql, params),
  exec: (sql) => adapter.exec(sql),
  close: () => adapter.close(),
  migrate,
  now,
  driver: adapter.driver,
  location: adapter.location,
  isPostgres: USE_POSTGRES,
};
