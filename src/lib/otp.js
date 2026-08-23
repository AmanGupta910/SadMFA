'use strict';

/**
 * One-Time Password handling (MFA STEP 2 - the "possession factor").
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { config } = require('../config/env');

/**
 * Generates a numeric OTP using crypto.randomInt.
 *
 * crypto.randomInt draws from the OS cryptographically secure random source and
 * is free of the modulo bias you get from `Math.floor(Math.random() * n)`.
 * Math.random() must never be used for security values - it is predictable.
 */
function generateOtp() {
  const digits = config.otpLength;
  const upperBound = 10 ** digits;              // 1_000_000 for 6 digits
  const value = crypto.randomInt(0, upperBound); // 0 .. 999999 inclusive-exclusive
  return String(value).padStart(digits, '0');    // keep leading zeros, e.g. "004271"
}

/**
 * Hashes an OTP before storing it.
 *
 * A 6-digit code has only ~20 bits of entropy, so a fast hash (plain SHA-256)
 * could be brute-forced from a stolen database in milliseconds. bcrypt is
 * deliberately slow, and the server-side pepper means the database alone is not
 * enough to test guesses.
 */
async function hashOtp(otp) {
  return bcrypt.hash(otp + config.hashPepper, 10);
}

async function verifyOtp(candidate, storedHash) {
  if (!storedHash) return false;
  return bcrypt.compare(String(candidate) + config.hashPepper, storedHash);
}

/** Accepts only the exact expected number of digits - nothing else. */
function isWellFormedOtp(value) {
  return new RegExp('^[0-9]{' + config.otpLength + '}$').test(String(value || '').trim());
}

module.exports = { generateOtp, hashOtp, verifyOtp, isWellFormedOtp };
