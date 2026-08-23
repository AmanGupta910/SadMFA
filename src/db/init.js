'use strict';

/**
 * Database bootstrap script.
 *   npm run init-db    -> create tables if they do not exist
 *   npm run reset-db   -> drop everything and start from a clean database
 */

const { db, migrate, DB_FILE } = require('./index');

const shouldReset = process.argv.includes('--reset');

if (shouldReset) {
  db.exec('DROP TABLE IF EXISTS auth_events;');
  db.exec('DROP TABLE IF EXISTS mfa_sessions;');
  db.exec('DROP TABLE IF EXISTS users;');
  console.log('  All tables dropped.');
}

migrate();

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => row.name);

console.log(`  Database ready at: ${DB_FILE}`);
console.log(`  Tables: ${tables.join(', ')}`);
