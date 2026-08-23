'use strict';

/**
 * SQLite connection.
 *
 * Uses `node:sqlite`, which ships inside Node.js 22.5+. That keeps the project
 * dependency-free on the database side: no native compiler, no database server
 * to install before the demo.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

/**
 * Where the database file lives.
 *
 * Defaults to ./data next to the source, which is what you want locally. In a
 * deployment set DATA_DIR to a mounted persistent disk (for example
 * /var/data on Render), otherwise the file sits on the container's temporary
 * filesystem and every account disappears on the next restart.
 */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', '..', 'data');

const DB_FILE = path.join(DATA_DIR, 'gocart-mfa.db');
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);

// WAL keeps reads fast while a write is in progress; both pragmas are standard.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/** Creates any missing tables. Safe to call on every boot (all DDL is IF NOT EXISTS). */
function migrate() {
  db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}

/** Current UTC timestamp in ISO-8601 - the format every date column uses. */
const now = () => new Date().toISOString();

module.exports = { db, migrate, now, DB_FILE };
