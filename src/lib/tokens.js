'use strict';

/**
 * Email verification tokens (MFA STEP 3 - the "yes, it's me" approval link).
 */

const crypto = require('node:crypto');
const { config } = require('../config/env');

/**
 * 32 random bytes = 256 bits of entropy, printed as 64 hex characters.
 * Guessing one is computationally infeasible, so unlike the 6-digit OTP this
 * value does not need a slow hash.
 */
function generateEmailToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Stores only SHA-256(token + pepper). If the database leaked, the stored value
 * cannot be turned back into a working link. SHA-256 is the right choice here
 * because the token already has 256 bits of entropy - brute force is hopeless
 * regardless of hash speed.
 */
function hashEmailToken(token) {
  return crypto.createHash('sha256').update(String(token) + config.hashPepper).digest('hex');
}

/** Timing-safe comparison of two hex digests. */
function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a || ''), 'utf8');
  const bufferB = Buffer.from(String(b || ''), 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/** Rejects anything that is not a 64-character hex string before hitting the DB. */
function isWellFormedToken(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim());
}

module.exports = { generateEmailToken, hashEmailToken, safeEqual, isWellFormedToken };
