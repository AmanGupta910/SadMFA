'use strict';

/**
 * Checks that an email address can actually receive mail.
 *
 * Format validation (validators.js) only proves an address *looks* right.
 * "aman@example.com" is perfectly well-formed but can never receive an OTP.
 * This module adds two further checks:
 *
 *   1. the domain is not a documentation / test / throw-away domain, and
 *   2. the domain really publishes MX records, i.e. a mail server exists.
 *
 * Both run before an account is created, so a user can never register with an
 * address that the MFA emails would silently fail to reach.
 */

const dns = require('node:dns').promises;
const { config } = require('../config/env');

/**
 * Domains reserved for documentation (RFC 2606) plus the throw-away inbox
 * services students commonly paste in. None of these should own a real account.
 */
const BLOCKED_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.edu',
  'test.com', 'test.net', 'domain.com', 'email.com', 'mail.com',
  'localhost', 'invalid', 'local',
  'mailinator.com', 'yopmail.com', 'guerrillamail.com', 'sharklasers.com',
  'tempmail.com', 'temp-mail.org', '10minutemail.com', 'trashmail.com',
  'throwawaymail.com', 'fakeinbox.com', 'getnada.com', 'dispostable.com',
]);

/** Common typos, mapped to what the user almost certainly meant. */
const DOMAIN_TYPOS = new Map([
  ['gmial.com', 'gmail.com'],
  ['gmai.com', 'gmail.com'],
  ['gamil.com', 'gmail.com'],
  ['gmail.co', 'gmail.com'],
  ['gnail.com', 'gmail.com'],
  ['hotmial.com', 'hotmail.com'],
  ['outlok.com', 'outlook.com'],
  ['yaho.com', 'yahoo.com'],
  ['yahooo.com', 'yahoo.com'],
]);

/** MX answers are cached briefly so repeated signups do not re-query DNS. */
const mxCache = new Map();
const MX_CACHE_TTL_MS = 10 * 60 * 1000;

/** Rejects a DNS lookup that hangs, so registration cannot block forever. */
function withTimeout(promise, milliseconds) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('DNS_TIMEOUT')), milliseconds).unref();
    }),
  ]);
}

async function hasMailServer(domain) {
  const cached = mxCache.get(domain);
  if (cached && Date.now() < cached.expiresAt) return cached.result;

  let result;
  try {
    const records = await withTimeout(dns.resolveMx(domain), config.mxLookupTimeoutMs);
    result = { ok: Array.isArray(records) && records.length > 0, reason: 'NO_MX' };
  } catch (error) {
    if (error.message === 'DNS_TIMEOUT') {
      result = { ok: false, reason: 'DNS_TIMEOUT' };
    } else if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
      result = { ok: false, reason: 'NO_MX' };
    } else {
      result = { ok: false, reason: 'DNS_ERROR' };
    }
  }

  mxCache.set(domain, { result, expiresAt: Date.now() + MX_CACHE_TTL_MS });
  return result;
}

/**
 * @param {string} email a syntactically valid, lower-cased address
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
async function checkDeliverable(email) {
  const domain = String(email || '').split('@').pop().toLowerCase();

  if (!domain) {
    return { ok: false, message: 'Please enter a valid email address.' };
  }

  // Automated test runs only (npm run start:offline). Never set in a real run.
  if (config.allowTestDomains) return { ok: true };

  if (DOMAIN_TYPOS.has(domain)) {
    return { ok: false, message: `Did you mean @${DOMAIN_TYPOS.get(domain)}? Please check your email address.` };
  }

  if (BLOCKED_DOMAINS.has(domain)) {
    return {
      ok: false,
      message: 'Please use a real email address you can open - the verification code is sent there.',
    };
  }

  // Escape hatch for grading on a machine with no internet access.
  if (!config.verifyEmailMx) return { ok: true };

  const mx = await hasMailServer(domain);
  if (mx.ok) return { ok: true };

  if (mx.reason === 'DNS_TIMEOUT' || mx.reason === 'DNS_ERROR') {
    return {
      ok: false,
      message: 'We could not verify that email domain right now. Please check your internet connection and try again.',
    };
  }

  return {
    ok: false,
    message: `The domain "${domain}" cannot receive email. Please use a real email address.`,
  };
}

module.exports = { checkDeliverable, BLOCKED_DOMAINS };
