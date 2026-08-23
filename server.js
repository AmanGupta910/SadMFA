'use strict';

/**
 * GoCart MFA - application entry point.
 *
 * Implementation of Multi-Factor Authentication using three authentication
 * steps: password, one-time password, and email approval.
 *
 * Start with:  npm start
 */

const path = require('node:path');
const express = require('express');
const session = require('express-session');

const { config, validateConfig } = require('./src/config/env');
const { db, migrate, DB_FILE } = require('./src/db');
const { SqliteSessionStore } = require('./src/db/sessionStore');
const mfaSessionRepo = require('./src/models/mfaSessionRepo');
const rateLimit = require('./src/lib/rateLimit');
const { verifyTransport } = require('./src/lib/mailer');

const authRoutes = require('./src/routes/auth');
const pageRoutes = require('./src/routes/pages');

validateConfig();
migrate();

const app = express();

// Express sits behind no proxy in the demo, but this keeps req.ip correct if it does.
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by'); // do not advertise the server technology

// --------------------------------------------------------------------------
// Baseline security headers (hand-rolled so the project stays dependency-light)
// --------------------------------------------------------------------------
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY'); // clickjacking protection
  res.set('Referrer-Policy', 'same-origin'); // never leak a token URL to another site
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  next();
});

// --------------------------------------------------------------------------
// Body parsing and static assets
// --------------------------------------------------------------------------
app.use(express.json({ limit: '16kb' })); // small cap: these forms are tiny
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
// Cache static assets in production only; during development an edited CSS or
// JS file must take effect on the next reload, not an hour later.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: config.isProduction ? '1h' : 0 }));

// --------------------------------------------------------------------------
// Session cookie
// --------------------------------------------------------------------------
app.use(
  session({
    name: 'gocart.sid', // do not reveal the framework via the default name
    secret: config.sessionSecret, // from .env, never hard-coded
    // Sessions live in SQLite, not in memory, so a restart or redeploy does not
    // log everybody out mid-MFA.
    store: new SqliteSessionStore(db, { ttlMs: config.mfaSessionTtlMinutes * 60 * 1000 }),
    resave: false,
    saveUninitialized: false, // no cookie until there is something to remember
    rolling: true, // sliding expiry while the user is active
    cookie: {
      httpOnly: true, // JavaScript cannot read the cookie (XSS mitigation)
      sameSite: 'lax', // CSRF mitigation; 'lax' still allows the emailed GET link
      secure: config.isProduction, // HTTPS-only in production
      maxAge: config.mfaSessionTtlMinutes * 60 * 1000,
    },
  })
);

/**
 * Cache-busting stamp appended to /css and /js URLs. It changes on every server
 * start, so after editing a stylesheet or script the browser is guaranteed to
 * fetch the new file instead of replaying a cached one.
 */
const ASSET_VERSION = String(Date.now());

// Values every template can use.
app.use((req, res, next) => {
  res.locals.demoMode = config.demoMode;
  res.locals.year = new Date().getFullYear();
  res.locals.assetVersion = ASSET_VERSION;
  res.locals.isAuthenticated = Boolean(req.session && req.session.userId && req.session.mfaCompleted);
  next();
});

// --------------------------------------------------------------------------
// Health check - hosting platforms poll this to decide if the app is alive.
// Deliberately reveals nothing about configuration or secrets.
// --------------------------------------------------------------------------
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get(); // prove the database is reachable too
    return res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  } catch (error) {
    return res.status(503).json({ status: 'unhealthy' });
  }
});

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/', pageRoutes);

// --------------------------------------------------------------------------
// 404
// --------------------------------------------------------------------------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Endpoint not found.' });
  }
  return res.status(404).render('error', {
    title: 'Page Not Found | GoCart',
    heading: 'Page Not Found',
    message: 'The page you are looking for does not exist.',
  });
});

// --------------------------------------------------------------------------
// Central error handler
//
// The real error (stack trace, SQL text, file paths) is logged on the server
// only. The browser receives a short generic message, so internal details can
// never leak to an attacker.
// --------------------------------------------------------------------------
app.use((error, req, res, next) => {
  console.error('  Unhandled error:', error);

  if (res.headersSent) return next(error);

  if (req.path.startsWith('/api/')) {
    return res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: 'Something went wrong on our side. Please try again.',
    });
  }

  return res.status(500).render('error', {
    title: 'Something Went Wrong | GoCart',
    heading: 'Something Went Wrong',
    message: 'An unexpected error occurred. Please try again.',
  });
});

// --------------------------------------------------------------------------
// Housekeeping: drop stale MFA ceremonies and rate-limit counters every 5 min.
// --------------------------------------------------------------------------
const cleanupTimer = setInterval(() => {
  try {
    const removed = mfaSessionRepo.purgeExpired();
    rateLimit.sweep();
    if (removed > 0) console.log(`  Cleanup: removed ${removed} expired MFA session(s).`);
  } catch (error) {
    console.error('  Cleanup failed:', error.message);
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------
const server = app.listen(config.port, async () => {
  const mail = await verifyTransport();

  console.log('');
  console.log('  ==========================================================');
  console.log('    GoCart - Multi-Factor Authentication Demo');
  console.log('  ==========================================================');
  console.log(`    URL         : ${config.baseUrl}`);
  console.log(`    Environment : ${config.nodeEnv}`);
  console.log(`    Mail        : ${config.mailTransport}${mail.ok ? '' : `  (WARNING: ${mail.error})`}`);
  console.log(`    Demo mode   : ${config.demoMode ? 'ON  (OTP shown on screen)' : 'OFF'}`);
  console.log('  ----------------------------------------------------------');
  console.log('    STEP 1  Password   ->  /login');
  console.log('    STEP 2  OTP        ->  /verify-otp');
  console.log('    STEP 3  Email      ->  /verify-email');
  console.log('    Success            ->  /dashboard');
  console.log('  ==========================================================');
  console.log('');
});

/** Shut down cleanly on Ctrl+C so the SQLite file is never left mid-write. */
function shutdown(signal) {
  console.log(`\n  ${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
