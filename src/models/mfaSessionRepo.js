'use strict';

/**
 * Data access for `mfa_sessions` - the temporary state of one login ceremony.
 *
 * A row is created the moment the password check succeeds (STEP 1) and is the
 * only place that records how far the user has progressed. The final logged-in
 * session is issued only when mfa_completed = 1.
 */

const crypto = require('node:crypto');
const db = require('../db');
const { config } = require('../config/env');

const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();
const isExpired = (isoTimestamp) => !isoTimestamp || new Date(isoTimestamp).getTime() <= Date.now();

/** 256-bit random identifier - unguessable, unlike an auto-increment integer. */
const newSessionId = () => crypto.randomBytes(32).toString('hex');

/** Opens a fresh ceremony after a correct password. */
async function createSession({ userId, ipAddress, userAgent }) {
  const id = newSessionId();
  const timestamp = db.now();

  return db.get(
    `INSERT INTO mfa_sessions
       (id, user_id, password_verified, status, ip_address, user_agent, created_at, updated_at, expires_at)
     VALUES (?, ?, 1, 'pending', ?, ?, ?, ?, ?)
     RETURNING *`,
    [
      id,
      userId,
      ipAddress || null,
      userAgent || null,
      timestamp,
      timestamp,
      minutesFromNow(config.mfaSessionTtlMinutes),
    ]
  );
}

async function findById(id) {
  if (!id) return null;
  return db.get('SELECT * FROM mfa_sessions WHERE id = ?', [id]);
}

/** Looks a ceremony up by the hash of the emailed token (STEP 3). */
async function findByEmailTokenHash(tokenHash) {
  return db.get('SELECT * FROM mfa_sessions WHERE email_token_hash = ?', [tokenHash]);
}

/** Generic guarded update - only known columns can ever be written. */
const UPDATABLE = new Set([
  'otp_hash', 'otp_expires_at', 'otp_attempts', 'otp_resend_count', 'otp_last_sent_at', 'otp_verified',
  'email_token_hash', 'email_token_expires_at', 'email_resend_count', 'email_last_sent_at', 'email_verified',
  'mfa_completed', 'status',
]);

async function update(id, fields) {
  const columns = Object.keys(fields).filter((column) => UPDATABLE.has(column));
  if (columns.length === 0) return findById(id);

  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  const values = columns.map((column) => fields[column]);

  return db.get(
    `UPDATE mfa_sessions SET ${assignments}, updated_at = ? WHERE id = ? RETURNING *`,
    [...values, db.now(), id]
  );
}

/**
 * Stores a new OTP. Writing a new hash automatically invalidates the previous
 * OTP (it is overwritten) and resets the attempt counter for the new code.
 */
async function setOtp(id, { otpHash, resendCount }) {
  return update(id, {
    otp_hash: otpHash,
    otp_expires_at: minutesFromNow(config.otpTtlMinutes),
    otp_attempts: 0,
    otp_verified: 0,
    otp_last_sent_at: db.now(),
    otp_resend_count: resendCount,
  });
}

async function incrementOtpAttempts(id) {
  return db.get(
    'UPDATE mfa_sessions SET otp_attempts = otp_attempts + 1, updated_at = ? WHERE id = ? RETURNING *',
    [db.now(), id]
  );
}

/** Burns the OTP: marks it verified and clears the hash so it cannot be reused. */
async function markOtpVerified(id) {
  return update(id, { otp_verified: 1, otp_hash: null, otp_expires_at: null });
}

async function setEmailToken(id, { tokenHash, resendCount }) {
  return update(id, {
    email_token_hash: tokenHash,
    email_token_expires_at: minutesFromNow(config.emailTokenTtlMinutes),
    email_last_sent_at: db.now(),
    email_resend_count: resendCount,
    email_verified: 0,
  });
}

/** Burns the email token and completes the ceremony. */
async function markEmailVerifiedAndComplete(id) {
  return update(id, {
    email_verified: 1,
    email_token_hash: null,
    email_token_expires_at: null,
    mfa_completed: 1,
    status: 'completed',
  });
}

async function lockSession(id, reason) {
  return update(id, { status: reason || 'locked' });
}

/** Cancels any other pending ceremony for this user (one login attempt at a time). */
async function expireOtherPendingSessions(userId, keepSessionId) {
  await db.run(
    `UPDATE mfa_sessions
        SET status = 'superseded', otp_hash = NULL, email_token_hash = NULL, updated_at = ?
      WHERE user_id = ? AND id <> ? AND status = 'pending'`,
    [db.now(), userId, keepSessionId]
  );
}

/** Housekeeping: drop ceremonies whose overall deadline has passed. */
async function purgeExpired() {
  // RETURNING makes the deleted-row count available on Postgres too, where the
  // HTTP driver reports rows rather than an affected-row count.
  const result = await db.run(
    "DELETE FROM mfa_sessions WHERE expires_at <= ? AND status <> 'completed' RETURNING id",
    [db.now()]
  );
  return result.changes;
}

/** Progress summary used by the UI and by the dashboard. */
function toProgress(session) {
  if (!session) return null;
  return {
    passwordVerified: Boolean(session.password_verified),
    otpVerified: Boolean(session.otp_verified),
    emailVerified: Boolean(session.email_verified),
    mfaCompleted: Boolean(session.mfa_completed),
    status: session.status,
  };
}

module.exports = {
  createSession,
  findById,
  findByEmailTokenHash,
  update,
  setOtp,
  incrementOtpAttempts,
  markOtpVerified,
  setEmailToken,
  markEmailVerifiedAndComplete,
  lockSession,
  expireOtherPendingSessions,
  purgeExpired,
  toProgress,
  isExpired,
  minutesFromNow,
};
