'use strict';

/** Append-only audit log. Useful as evidence when demonstrating the project. */

const { db, now } = require('../db');

function record({ userId = null, mfaSessionId = null, event, detail = null, ipAddress = null }) {
  db.prepare(
    `INSERT INTO auth_events (user_id, mfa_session_id, event, detail, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, mfaSessionId, event, detail, ipAddress, now());
}

function recentForUser(userId, limit = 10) {
  return db
    .prepare('SELECT event, detail, created_at FROM auth_events WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit);
}

module.exports = { record, recentForUser };
