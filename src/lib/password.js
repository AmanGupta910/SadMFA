'use strict';

/**
 * Password hashing (MFA STEP 1 - the "knowledge factor").
 *
 * bcrypt is a deliberately slow, salted hash. Every password gets a unique
 * random salt, so two users with the same password produce different hashes
 * and a pre-computed rainbow table is useless.
 */

const bcrypt = require('bcryptjs');
const { config } = require('../config/env');

/** Hashes a plain password. The plain value is never persisted anywhere. */
async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, config.bcryptRounds);
}

/**
 * Compares a candidate password against the stored hash.
 * bcrypt.compare is constant-time with respect to the hash, so it does not leak
 * information through timing differences.
 */
async function verifyPassword(plainPassword, storedHash) {
  if (!storedHash) return false;
  return bcrypt.compare(plainPassword, storedHash);
}

/**
 * Runs a throw-away bcrypt comparison so that a login attempt for an unknown
 * email costs the same time as one for a real account. Without this, an
 * attacker could measure response times to discover which emails are registered
 * (a user-enumeration side channel).
 */
const DUMMY_HASH = bcrypt.hashSync('gocart-dummy-password-for-timing', 10);

async function wasteTimeLikeARealCheck() {
  await bcrypt.compare('gocart-dummy-password-for-timing', DUMMY_HASH);
}

module.exports = { hashPassword, verifyPassword, wasteTimeLikeARealCheck };
