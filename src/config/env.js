'use strict';

/**
 * Central configuration.
 *
 * Every tunable value is read from environment variables (see .env.example) so
 * that no secret, credential or policy number is hard-coded in the source.
 */

require('dotenv').config({ quiet: true });

const num = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
};

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const config = {
  nodeEnv,
  isProduction,
  port: num(process.env.PORT, 3000),
  baseUrl: (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),

  sessionSecret: process.env.SESSION_SECRET,
  hashPepper: process.env.HASH_PEPPER || '',

  // MFA policy
  bcryptRounds: num(process.env.BCRYPT_ROUNDS, 12),
  otpLength: num(process.env.OTP_LENGTH, 6),
  otpTtlMinutes: num(process.env.OTP_TTL_MINUTES, 5),
  otpMaxAttempts: num(process.env.OTP_MAX_ATTEMPTS, 5),
  otpResendCooldownSeconds: num(process.env.OTP_RESEND_COOLDOWN_SECONDS, 30),
  otpMaxResends: num(process.env.OTP_MAX_RESENDS, 3),
  emailTokenTtlMinutes: num(process.env.EMAIL_TOKEN_TTL_MINUTES, 15),
  emailResendCooldownSeconds: num(process.env.EMAIL_RESEND_COOLDOWN_SECONDS, 60),
  mfaSessionTtlMinutes: num(process.env.MFA_SESSION_TTL_MINUTES, 20),
  loginMaxAttempts: num(process.env.LOGIN_MAX_ATTEMPTS, 5),
  loginWindowMinutes: num(process.env.LOGIN_WINDOW_MINUTES, 15),

  // Deliverability: reject addresses whose domain has no mail server.
  verifyEmailMx: bool(process.env.VERIFY_EMAIL_MX, true),
  mxLookupTimeoutMs: num(process.env.MX_LOOKUP_TIMEOUT_MS, 5000),

  /**
   * Lets the automated test suite register @example.com accounts. Set only by
   * `npm run start:offline`, never in a real run, and never in production.
   */
  allowTestDomains: bool(process.env.ALLOW_TEST_DOMAINS, false) && !isProduction,

  // Mail
  mailTransport: (process.env.MAIL_TRANSPORT || 'smtp').toLowerCase(),
  email: {
    host: process.env.EMAIL_HOST,
    port: num(process.env.EMAIL_PORT, 587),
    secure: bool(process.env.EMAIL_SECURE, false),
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASSWORD,
    from: process.env.EMAIL_FROM || 'GoCart Security <no-reply@gocart.local>',
  },

  /**
   * Demo mode reveals the OTP and the verification link in the UI so the flow
   * can be demonstrated without an inbox. It is force-disabled in production so
   * a misconfigured deployment can never leak an authentication secret.
   */
  demoMode: bool(process.env.DEMO_MODE, false) && !isProduction,
};

/** Fail fast on missing secrets rather than silently running insecurely. */
function validateConfig() {
  const problems = [];

  if (!config.sessionSecret || config.sessionSecret.length < 16) {
    problems.push('SESSION_SECRET is missing or too short (need >= 16 characters).');
  }
  if (config.sessionSecret === 'replace-with-a-long-random-string') {
    problems.push('SESSION_SECRET still holds the placeholder value from .env.example.');
  }
  if (!config.hashPepper || config.hashPepper.length < 16) {
    problems.push('HASH_PEPPER is missing or too short (need >= 16 characters).');
  }
  if (isProduction) {
    // The "YES, IT'S ME" link is built from APP_BASE_URL. If that still points
    // at localhost, every verification email ships a link nobody can open, and
    // the failure only shows up in the user's inbox - so refuse to start.
    if (/localhost|127\.0\.0\.1/i.test(config.baseUrl)) {
      problems.push(
        `APP_BASE_URL is "${config.baseUrl}" but NODE_ENV=production.\n` +
          '     Set it to the public address of the site, e.g. https://your-app.onrender.com'
      );
    }
    // Session cookies are marked "secure" in production, so the browser will
    // refuse to send them over plain HTTP and nobody could stay logged in.
    if (!config.baseUrl.startsWith('https://')) {
      problems.push(`APP_BASE_URL must start with https:// in production (got "${config.baseUrl}").`);
    }
    if (config.mailTransport !== 'smtp') {
      problems.push('MAIL_TRANSPORT must be "smtp" in production so real emails are actually sent.');
    }
  }

  if (config.mailTransport === 'smtp') {
    if (!config.email.host) problems.push('MAIL_TRANSPORT=smtp but EMAIL_HOST is not set.');
    if (!config.email.user) problems.push('MAIL_TRANSPORT=smtp but EMAIL_USER is not set.');
    if (!config.email.password) problems.push('MAIL_TRANSPORT=smtp but EMAIL_PASSWORD is not set.');

    // The template ships with dummy values. Running with them still "starts"
    // but no email ever arrives, which is confusing - so refuse instead.
    const placeholders = ['smtp.example.com', 'demo@example.com', 'demo-password', 'your-app-password'];
    const stillPlaceholder = [config.email.host, config.email.user, config.email.password].filter((value) =>
      placeholders.includes(String(value))
    );
    if (stillPlaceholder.length > 0) {
      problems.push(
        'EMAIL_* still contains the example values from .env.example, so no mail can be sent.\n' +
          '     Run:  npm run setup-email'
      );
    }
  }

  if (problems.length > 0) {
    console.error('\n  Configuration error - the server cannot start:\n');
    for (const problem of problems) console.error(`   - ${problem}`);
    console.error('\n  Fix your .env file (copy .env.example if you have not yet).\n');
    process.exit(1);
  }
}

module.exports = { config, validateConfig };
