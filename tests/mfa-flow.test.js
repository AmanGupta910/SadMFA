'use strict';

/**
 * End-to-end test of the whole MFA flow against a running server.
 *
 *   1. npm start          (in one terminal)
 *   2. npm test           (in another)
 *
 * It walks the assignment's testing checklist item by item and prints a table.
 * It talks to the HTTP API exactly like a browser does, using a cookie jar, so
 * it proves the real request/response behaviour rather than calling functions.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const BASE = process.env.APP_BASE_URL || 'http://localhost:3000';
const DB_FILE = path.join(__dirname, '..', 'data', 'gocart-mfa.db');

const results = [];
let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    results.push({ status: 'PASS', label, detail: detail || '' });
  } else {
    failed += 1;
    results.push({ status: 'FAIL', label, detail: detail || '' });
  }
}

// ---------------------------------------------------------------- cookie jar
function makeJar() {
  const jar = new Map();

  return {
    header() {
      return Array.from(jar.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    },
    absorb(response) {
      const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      for (const cookie of raw) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
    clear() {
      jar.clear();
    },
  };
}

async function request(jar, method, urlPath, body, accept) {
  const headers = { Accept: accept || 'application/json' };
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Type'] = 'application/json';

  const response = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  jar.absorb(response);

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();

  return { status: response.status, data: payload, headers: response.headers };
}

const post = (jar, urlPath, body) => request(jar, 'POST', urlPath, body || {});
const get = (jar, urlPath) => request(jar, 'GET', urlPath);

/** Requests a page the way a browser does, so guards redirect instead of returning JSON. */
const getPage = (jar, urlPath) => request(jar, 'GET', urlPath, null, 'text/html,application/xhtml+xml');

// ------------------------------------------------------------------ helpers
function db() {
  return new DatabaseSync(DB_FILE);
}

/** Reads the newest MFA session row for a user straight from the database. */
function latestSession(email) {
  const connection = db();
  const row = connection
    .prepare(
      `SELECT s.* FROM mfa_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE u.email = ?
        ORDER BY s.created_at DESC, s.rowid DESC
        LIMIT 1`
    )
    .get(email);
  connection.close();
  return row;
}

function userRow(email) {
  const connection = db();
  const row = connection.prepare('SELECT * FROM users WHERE email = ?').get(email);
  connection.close();
  return row;
}

/** Forces a timestamp into the past so expiry paths can be tested instantly. */
function expireColumn(sessionId, column) {
  backdate(sessionId, column, 60);
}

/**
 * Moves a timestamp `seconds` into the past.
 * Used to simulate the passage of time instead of really waiting, so an expiry
 * or a resend cooldown can be exercised in a fast test run.
 */
function backdate(sessionId, column, seconds) {
  const connection = db();
  connection
    .prepare(`UPDATE mfa_sessions SET ${column} = ? WHERE id = ?`)
    .run(new Date(Date.now() - seconds * 1000).toISOString(), sessionId);
  connection.close();
}

const stamp = Date.now();
const USER = {
  name: 'Aman Gupta',
  email: `aman.test.${stamp}@example.com`,
  password: 'GoCart@2026',
  confirmPassword: 'GoCart@2026',
};

// =========================================================================
async function run() {
  console.log(`\n  Running MFA flow tests against ${BASE}\n`);

  // --- reachability -------------------------------------------------------
  const jar = makeJar();
  try {
    await getPage(jar, '/login');
  } catch (error) {
    console.error('  Cannot reach the server. Start it first with:  npm start\n');
    process.exit(1);
  }

  // === 1. REGISTRATION ====================================================
  const register = await post(jar, '/api/auth/register', USER);
  check('User registration works', register.status === 201 && register.data.success === true, `status ${register.status}`);

  check(
    'Registration response never contains a password',
    !JSON.stringify(register.data).toLowerCase().includes('password'),
    'no password field in JSON'
  );

  // === 2. DUPLICATE REGISTRATION ==========================================
  const duplicate = await post(jar, '/api/auth/register', USER);
  check(
    'Duplicate registration rejected',
    duplicate.status === 409 && duplicate.data.error === 'EMAIL_EXISTS',
    `status ${duplicate.status}`
  );

  // === 3. PASSWORD IS HASHED ==============================================
  const stored = userRow(USER.email);
  check(
    'Password is hashed (bcrypt) in the database',
    Boolean(stored) && stored.password_hash.startsWith('$2') && !stored.password_hash.includes(USER.password),
    stored ? stored.password_hash.slice(0, 7) + '...' : 'user missing'
  );

  // === 4. WEAK PASSWORD / MISMATCH / BAD EMAIL ============================
  const weak = await post(jar, '/api/auth/register', {
    name: 'Weak User',
    email: `weak.${stamp}@example.com`,
    password: 'abc',
    confirmPassword: 'abc',
  });
  check('Weak password rejected', weak.status === 400 && weak.data.error === 'VALIDATION_ERROR', weak.data.message);

  const mismatch = await post(jar, '/api/auth/register', {
    name: 'Mismatch User',
    email: `mismatch.${stamp}@example.com`,
    password: 'GoCart@2026',
    confirmPassword: 'GoCart@2027',
  });
  check('Password mismatch rejected', mismatch.status === 400, mismatch.data.message);

  const badEmail = await post(jar, '/api/auth/register', {
    name: 'Bad Email',
    email: 'not-an-email',
    password: 'GoCart@2026',
    confirmPassword: 'GoCart@2026',
  });
  check('Invalid email rejected', badEmail.status === 400, badEmail.data.message);

  // === 5. DASHBOARD BLOCKED BEFORE ANY LOGIN ==============================
  const preLogin = await get(jar, '/api/auth/mfa-status');
  check('No MFA session before login', preLogin.status === 401, `status ${preLogin.status}`);

  // === 6. WRONG PASSWORD ==================================================
  const wrongPassword = await post(jar, '/api/auth/login', { email: USER.email, password: 'WrongPass@1' });
  check(
    'Login with wrong password rejected',
    wrongPassword.status === 401 && wrongPassword.data.error === 'INVALID_CREDENTIALS',
    `status ${wrongPassword.status}`
  );

  check(
    'Wrong password gives a generic message (no user enumeration)',
    wrongPassword.data.message === 'Invalid email or password.',
    wrongPassword.data.message
  );

  const unknownUser = await post(jar, '/api/auth/login', { email: `ghost.${stamp}@example.com`, password: 'Whatever@1' });
  check(
    'Unknown email gives the same generic message',
    unknownUser.data.message === wrongPassword.data.message,
    unknownUser.data.message
  );

  // === 7. CORRECT PASSWORD -> STEP 2 ======================================
  const login = await post(jar, '/api/auth/login', { email: USER.email, password: USER.password });
  check(
    'Login with correct password proceeds to OTP',
    login.status === 200 && login.data.success === true && login.data.redirect === '/verify-otp',
    `step ${login.data.step}`
  );

  check('Login response masks the email address', typeof login.data.maskedEmail === 'string' && login.data.maskedEmail.includes('*'), login.data.maskedEmail);

  let session = latestSession(USER.email);
  check('OTP is generated and stored as a hash', Boolean(session && session.otp_hash && session.otp_hash.startsWith('$2')), session ? session.otp_hash.slice(0, 7) + '...' : 'none');
  check('OTP has an expiry timestamp', Boolean(session && session.otp_expires_at), session ? session.otp_expires_at : 'none');
  check('Password step recorded, OTP step not yet', session.password_verified === 1 && session.otp_verified === 0, `pw=${session.password_verified} otp=${session.otp_verified}`);

  // === 8. DASHBOARD BLOCKED AFTER PASSWORD ONLY ===========================
  const dashboardAfterPassword = await getPage(jar, '/dashboard');
  check(
    'Dashboard inaccessible after password only',
    dashboardAfterPassword.status === 302 && String(dashboardAfterPassword.headers.get('location')).includes('/login'),
    `status ${dashboardAfterPassword.status} -> ${dashboardAfterPassword.headers.get('location')}`
  );

  // === 9. SKIPPING STEP 3 IS BLOCKED ======================================
  const skipToEmail = await post(jar, '/api/auth/send-email-verification', {});
  check(
    'Cannot start email step before OTP is verified',
    skipToEmail.status === 403 && skipToEmail.data.error === 'OTP_NOT_VERIFIED',
    `status ${skipToEmail.status}`
  );

  // === 10. WRONG OTP ======================================================
  const demoOtp = login.data.demoOtp;

  // The OTP normally exists only inside the email, which an automated test
  // cannot open. The offline/test server exposes it deliberately.
  if (typeof demoOtp !== 'string') {
    report();
    console.error('  The server is running in real-email mode, so the OTP is not readable here.');
    console.error('  Start the test server instead, in another terminal:\n');
    console.error('      npm run start:offline\n');
    process.exit(1);
  }

  check('Test mode exposed the OTP for automation', demoOtp.length === 6, 'received');

  const wrongOtp = demoOtp === '000000' ? '111111' : '000000';
  const badOtp = await post(jar, '/api/auth/verify-otp', { otp: wrongOtp });
  check(
    'Wrong OTP rejected',
    badOtp.status === 401 && badOtp.data.error === 'INVALID_OTP',
    `attemptsRemaining ${badOtp.data.attemptsRemaining}`
  );
  check('Failed OTP attempts are counted', badOtp.data.attemptsRemaining === 4, `remaining ${badOtp.data.attemptsRemaining}`);

  const malformedOtp = await post(jar, '/api/auth/verify-otp', { otp: '12ab' });
  check('Malformed OTP rejected', malformedOtp.status === 400 && malformedOtp.data.error === 'INVALID_OTP_FORMAT', `status ${malformedOtp.status}`);

  // === 11. EXPIRED OTP ====================================================
  session = latestSession(USER.email);
  expireColumn(session.id, 'otp_expires_at');
  const expiredOtp = await post(jar, '/api/auth/verify-otp', { otp: demoOtp });
  check('Expired OTP rejected', expiredOtp.status === 410 && expiredOtp.data.error === 'OTP_EXPIRED', `status ${expiredOtp.status}`);

  // === 12. RESEND OTP =====================================================
  // Pretend the resend cooldown has already elapsed (the code was sent minutes
  // ago), instead of really sleeping for 30 seconds.
  backdate(session.id, 'otp_last_sent_at', 120);

  const resend = await post(jar, '/api/auth/resend-otp', {});
  check('OTP resend works', resend.status === 200 && resend.data.success === true, resend.data.message);

  const newOtp = resend.data.demoOtp;
  check('Resend issues a different OTP hash', latestSession(USER.email).otp_hash !== session.otp_hash, 'hash changed');

  const oldOtpAfterResend = await post(jar, '/api/auth/verify-otp', { otp: demoOtp });
  check(
    'Old OTP stops working after a resend',
    oldOtpAfterResend.status === 401,
    `status ${oldOtpAfterResend.status}`
  );

  // resend cooldown
  const rapidResend = await post(jar, '/api/auth/resend-otp', {});
  check('Resend cooldown enforced', rapidResend.status === 429 && rapidResend.data.error === 'RESEND_COOLDOWN', rapidResend.data.message);

  // === 13. CORRECT OTP ====================================================
  const goodOtp = await post(jar, '/api/auth/verify-otp', { otp: newOtp });
  check(
    'Correct OTP accepted',
    goodOtp.status === 200 && goodOtp.data.success === true && goodOtp.data.redirect === '/verify-email',
    `step ${goodOtp.data.step}`
  );

  session = latestSession(USER.email);
  check('OTP hash cleared after use (one-time use)', session.otp_verified === 1 && session.otp_hash === null, 'burned');

  // === 14. DASHBOARD STILL BLOCKED AFTER 2 OF 3 ===========================
  const dashboardAfterOtp = await getPage(jar, '/dashboard');
  check(
    'Dashboard inaccessible after password + OTP only',
    dashboardAfterOtp.status === 302 && String(dashboardAfterOtp.headers.get('location')).includes('/login'),
    `status ${dashboardAfterOtp.status}`
  );

  // === 15. EMAIL VERIFICATION =============================================
  const sendEmail = await post(jar, '/api/auth/send-email-verification', {});
  check('Email verification email is generated', sendEmail.status === 200 && sendEmail.data.success === true, sendEmail.data.message);

  const verifyUrl = sendEmail.data.demoVerifyUrl;
  check('Verification link contains a token', typeof verifyUrl === 'string' && verifyUrl.includes('token='), verifyUrl ? 'present' : 'missing');

  session = latestSession(USER.email);
  const rawToken = verifyUrl.split('token=')[1];
  check(
    'Raw token is NOT stored in the database (only its hash)',
    session.email_token_hash !== rawToken && session.email_token_hash.length === 64,
    'sha256 hash stored'
  );
  check('Token is 256-bit (64 hex chars)', rawToken.length === 64, `${rawToken.length} chars`);

  // --- invalid token ------------------------------------------------------
  const badToken = await getPage(makeJar(), '/api/auth/verify-email?token=deadbeef');
  check('Invalid email token rejected', badToken.status === 400 && String(badToken.data).includes('Invalid Verification Link'), `status ${badToken.status}`);

  const wellFormedButUnknown = 'a'.repeat(64);
  const unknownToken = await getPage(makeJar(), `/api/auth/verify-email?token=${wellFormedButUnknown}`);
  check('Unknown (well-formed) token rejected', unknownToken.status === 400, `status ${unknownToken.status}`);

  // --- expired token ------------------------------------------------------
  expireColumn(session.id, 'email_token_expires_at');
  const expiredToken = await getPage(makeJar(), `/api/auth/verify-email?token=${rawToken}`);
  check(
    'Expired email token rejected',
    expiredToken.status === 400 && String(expiredToken.data).includes('Expired'),
    `status ${expiredToken.status}`
  );

  // --- fresh token, then the real click -----------------------------------
  backdate(session.id, 'email_last_sent_at', 300); // skip the resend cooldown
  const resendEmail = await post(jar, '/api/auth/send-email-verification', {});
  const freshUrl = resendEmail.data.demoVerifyUrl;

  if (!freshUrl) {
    check('Could resend verification email', false, resendEmail.data.message || 'no demo url');
  } else {
    const freshToken = freshUrl.split('token=')[1];

    const clicked = await getPage(jar, `/api/auth/verify-email?token=${freshToken}`);
    check(
      '"Yes, It\'s Me" link works',
      clicked.status === 200 && String(clicked.data).includes('Email Verified Successfully'),
      `status ${clicked.status}`
    );

    session = latestSession(USER.email);
    check('MFA marked complete in the database', session.mfa_completed === 1 && session.status === 'completed', session.status);
    check('Email token cleared after use', session.email_token_hash === null, 'burned');

    // --- reuse the same token -------------------------------------------
    const reused = await getPage(makeJar(), `/api/auth/verify-email?token=${freshToken}`);
    check(
      'Email token cannot be reused',
      reused.status === 400 && String(reused.data).includes('Already Used'),
      `status ${reused.status}`
    );
  }

  // === 16. DASHBOARD NOW ACCESSIBLE =======================================
  const dashboard = await getPage(jar, '/dashboard');
  check(
    'Dashboard accessible after all 3 steps',
    dashboard.status === 200 && String(dashboard.data).includes('MFA COMPLETED SUCCESSFULLY'),
    `status ${dashboard.status}`
  );

  check(
    'Dashboard shows all three factors as COMPLETED',
    (String(dashboard.data).match(/COMPLETED/g) || []).length >= 4,
    'password + otp + email'
  );

  // === 17. LOGOUT =========================================================
  const logout = await post(jar, '/api/auth/logout', {});
  check('Logout works', logout.status === 200 && logout.data.success === true, logout.data.message);

  const dashboardAfterLogout = await getPage(jar, '/dashboard');
  check(
    'Dashboard blocked again after logout',
    dashboardAfterLogout.status === 302 && String(dashboardAfterLogout.headers.get('location')).includes('/login'),
    `status ${dashboardAfterLogout.status}`
  );

  // === 18. UNAUTHENTICATED VISITOR ========================================
  const stranger = makeJar();
  const strangerDashboard = await getPage(stranger, '/dashboard');
  check(
    'Unauthorized dashboard access blocked for a fresh visitor',
    strangerDashboard.status === 302,
    `status ${strangerDashboard.status}`
  );

  const strangerOtpPage = await getPage(stranger, '/verify-otp');
  check('OTP page blocked without a password step', strangerOtpPage.status === 302, `status ${strangerOtpPage.status}`);

  const strangerEmailPage = await getPage(stranger, '/verify-email');
  check('Email page blocked without an OTP step', strangerEmailPage.status === 302, `status ${strangerEmailPage.status}`);

  // === 19. OTP ATTEMPT LIMIT ==============================================
  const lockJar = makeJar();
  const lockUser = {
    name: 'Lock Test',
    email: `lock.${stamp}@example.com`,
    password: 'GoCart@2026',
    confirmPassword: 'GoCart@2026',
  };
  await post(lockJar, '/api/auth/register', lockUser);
  await post(lockJar, '/api/auth/login', { email: lockUser.email, password: lockUser.password });

  let lockResponse = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    lockResponse = await post(lockJar, '/api/auth/verify-otp', { otp: '000001' });
  }
  check(
    'Too many OTP attempts locks the login attempt',
    lockResponse.status === 429 && lockResponse.data.error === 'TOO_MANY_OTP_ATTEMPTS',
    `status ${lockResponse.status}`
  );

  const lockedSession = latestSession(lockUser.email);
  check('Locked session recorded in the database', lockedSession.status === 'locked', lockedSession.status);

  // === 20. EMAIL DELIVERABILITY RULES =====================================
  // Checked against the module directly. This test process does not set
  // ALLOW_TEST_DOMAINS, so the production rules apply here even though the
  // offline server relaxes them for the steps above.
  const { checkDeliverable } = require('../src/lib/emailDeliverability');

  const blockedDomain = await checkDeliverable('someone@example.com');
  check('Registration blocks example.com addresses', blockedDomain.ok === false, blockedDomain.message);

  const typo = await checkDeliverable('someone@gmial.com');
  check('Registration catches a gmail typo', typo.ok === false, typo.message);

  const disposable = await checkDeliverable('someone@mailinator.com');
  check('Registration blocks throw-away inboxes', disposable.ok === false, disposable.message);

  const noSuchDomain = await checkDeliverable('someone@thisdomaindoesnotexist12345.com');
  check('Registration blocks a domain with no mail server', noSuchDomain.ok === false, noSuchDomain.message);

  const realDomain = await checkDeliverable('someone@gmail.com');
  check('Registration accepts a real mail domain', realDomain.ok === true, 'gmail.com has MX records');

  // === 21. SECURITY HEADERS ===============================================
  const headerProbe = await fetch(`${BASE}/login`, { redirect: 'manual' });
  check('X-Frame-Options set (clickjacking)', headerProbe.headers.get('x-frame-options') === 'DENY', headerProbe.headers.get('x-frame-options'));
  check('X-Content-Type-Options set', headerProbe.headers.get('x-content-type-options') === 'nosniff', headerProbe.headers.get('x-content-type-options'));
  check('Auth pages are not cached', String(headerProbe.headers.get('cache-control')).includes('no-store'), headerProbe.headers.get('cache-control'));
  check('Server technology hidden', headerProbe.headers.get('x-powered-by') === null, 'x-powered-by absent');

  report();
  process.exit(failed === 0 ? 0 : 1);
}

function report() {
  console.log('  ' + '='.repeat(74));
  results.forEach((row, index) => {
    const mark = row.status === 'PASS' ? '[PASS]' : '[FAIL]';
    const number = String(index + 1).padStart(2, ' ');
    console.log(`  ${mark} ${number}. ${row.label}`);
    if (row.detail) console.log(`              ${row.detail}`);
  });
  console.log('  ' + '='.repeat(74));
  console.log(`  Passed: ${passed}   Failed: ${failed}   Total: ${results.length}`);
  console.log('  ' + '='.repeat(74) + '\n');
}

run().catch((error) => {
  report();
  console.error('  Test run crashed:', error.message);
  console.error(error.stack);
  process.exit(1);
});
