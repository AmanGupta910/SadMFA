'use strict';

/**
 * Data access for the `users` table.
 *
 * Every query uses prepared statements with bound parameters, so user input can
 * never be concatenated into SQL (SQL-injection protection).
 */

const { db, now } = require('../db');

/** Emails are compared case-insensitively, so they are stored normalised. */
const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

function findByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normaliseEmail(email));
}

function findById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function emailExists(email) {
  const row = db.prepare('SELECT 1 AS hit FROM users WHERE email = ?').get(normaliseEmail(email));
  return Boolean(row);
}

/** Inserts a new account. `passwordHash` must already be a bcrypt hash. */
function createUser({ name, email, passwordHash }) {
  const timestamp = now();
  const result = db
    .prepare(
      `INSERT INTO users (name, email, password_hash, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
    .run(String(name).trim(), normaliseEmail(email), passwordHash, timestamp, timestamp);

  return findById(Number(result.lastInsertRowid));
}

function markEmailVerified(userId) {
  db.prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?').run(now(), userId);
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
