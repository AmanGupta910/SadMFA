'use strict';

/**
 * Data access for the `users` table.
 *
 * Every query uses bound parameters, so user input can never be concatenated
 * into SQL (SQL-injection protection). Queries are written with `?` and the
 * database layer rewrites them for Postgres when deployed.
 */

const db = require('../db');

/** Emails are compared case-insensitively, so they are stored normalised. */
const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

async function findByEmail(email) {
  return db.get('SELECT * FROM users WHERE email = ?', [normaliseEmail(email)]);
}

async function findById(id) {
  return db.get('SELECT * FROM users WHERE id = ?', [id]);
}

async function emailExists(email) {
  const row = await db.get('SELECT 1 AS hit FROM users WHERE email = ?', [normaliseEmail(email)]);
  return Boolean(row);
}

/** Inserts a new account. `passwordHash` must already be a bcrypt hash. */
async function createUser({ name, email, passwordHash }) {
  const timestamp = db.now();

  // RETURNING is supported by both SQLite (3.35+) and Postgres, so one query
  // works on either engine and no follow-up SELECT is needed.
  return db.get(
    `INSERT INTO users (name, email, password_hash, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)
     RETURNING *`,
    [String(name).trim(), normaliseEmail(email), passwordHash, timestamp, timestamp]
  );
}

async function markEmailVerified(userId) {
  await db.run('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?', [db.now(), userId]);
}

/**
 * Strips every sensitive column before a user object is sent to the browser.
 * The password hash must never appear in an API response.
 */
function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: Boolean(user.email_verified),
    createdAt: user.created_at,
  };
}

module.exports = {
  normaliseEmail,
  findByEmail,
  findById,
  emailExists,
  createUser,
  markEmailVerified,
  toPublicUser,
};
