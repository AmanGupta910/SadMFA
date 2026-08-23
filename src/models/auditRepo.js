'use strict';

/** Append-only audit log. Useful as evidence when demonstrating the project. */

const db = require('../db');

async function record({ userId = null, mfaSessionId = null, event, detail = null, ipAddress = null }) {
  await db.run(
    `INSERT INTO auth_events (user_id, mfa_session_id, event, detail, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, mfaSessionId, event, detail, ipAddress, db.now()]
  );
}

async function recentForUser(userId, limit = 10) {
  return db.all(
    'SELECT event, detail, created_at FROM auth_events WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [userId, limit]
  );
}

module.exports = { record, recentForUser };
