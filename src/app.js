'use strict';

/**
 * Builds the Express application.
 *
 * Deliberately does NOT call app.listen(). Two different entry points use it:
 *   server.js      - local development, opens a port
 *   api/index.js   - Vercel, which invokes the app as a serverless function and
 *                    would break if the process tried to hold a port open.
 */

const path = require('node:path');
const express = require('express');
const session = require('express-session');

const { config } = require('./config/env');
const db = require('./db');
const { DatabaseSessionStore } = require('./db/sessionStore');
const mfaSessionRepo = require('./models/mfaSessionRepo');
const rateLimit = require('./lib/rateLimit');

const authRoutes = require('./routes/auth');
const pageRoutes = require('./routes/pages');

const ROOT = path.join(__dirname, '..');

function createApp() {
  const app = express();

  // Trust the platform's TLS-terminating proxy, so req.ip is the real client
  // address and "secure" cookies are recognised as being sent over HTTPS.
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.disable('x-powered-by'); // do not advertise the server technology

  // ------------------------------------------------------------------------
  // Baseline security headers
  // ------------------------------------------------------------------------
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

  // ------------------------------------------------------------------------
  // Body parsing and static assets
  // ------------------------------------------------------------------------
  app.use(express.json({ limit: '16kb' })); // small cap: these forms are tiny
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(express.static(path.join(ROOT, 'public'), { maxAge: config.isProduction ? '1h' : 0 }));

  // ------------------------------------------------------------------------
  // Make sure the schema exists before any request touches the database.
  // On a serverless platform there is no startup hook, so the first request
  // after a cold start performs the migration (the promise is cached, so this
  // costs nothing on later requests).
  // ------------------------------------------------------------------------
  app.use((req, res, next) => {
    db.migrate().then(() => next()).catch(next);
  });

  // ------------------------------------------------------------------------
  // Session cookie
  // ------------------------------------------------------------------------
  app.use(
    session({
      name: 'gocart.sid', // do not reveal the framework via the default name
      secret: config.sessionSecret, // from the environment, never hard-coded
      // Sessions live in the database, so a restart, a redeploy, or a request
      // landing on a different serverless instance does not lose them.
      store: new DatabaseSessionStore({ ttlMs: config.mfaSessionTtlMinutes * 60 * 1000 }),
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
   * Cache-busting stamp appended to /css and /js URLs, so an edited stylesheet
   * is never served from a stale browser cache.
   */
  const assetVersion = String(Date.now());

  app.use((req, res, next) => {
    res.locals.demoMode = config.demoMode;
    res.locals.year = new Date().getFullYear();
    res.locals.assetVersion = assetVersion;
    res.locals.isAuthenticated = Boolean(req.session && req.session.userId && req.session.mfaCompleted);
    next();
  });

  // ------------------------------------------------------------------------
  // Health check - hosting platforms poll this. Reveals no configuration.
  // ------------------------------------------------------------------------
  app.get('/healthz', async (req, res) => {
    try {
      await db.get('SELECT 1 AS ok');
      return res.json({ status: 'ok', driver: db.driver, uptime: Math.round(process.uptime()) });
    } catch (error) {
      return res.status(503).json({ status: 'unhealthy' });
    }
  });

  // ------------------------------------------------------------------------
  // Routes
  // ------------------------------------------------------------------------
  app.use('/api/auth', authRoutes);
  app.use('/', pageRoutes);

  // ------------------------------------------------------------------------
  // 404
  // ------------------------------------------------------------------------
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

  // ------------------------------------------------------------------------
  // Central error handler
  //
  // The real error (stack trace, SQL text, file paths) is logged on the server
  // only. The browser receives a short generic message, so internal details can
  // never leak to an attacker.
  // ------------------------------------------------------------------------
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

  return app;
}

/**
 * Periodic cleanup of expired MFA ceremonies and rate-limit counters.
 * Only started by the long-running server; a serverless instance is too
 * short-lived for a timer to be meaningful there.
 */
function startBackgroundCleanup() {
  const timer = setInterval(async () => {
    try {
      const removed = await mfaSessionRepo.purgeExpired();
      rateLimit.sweep();
      if (removed > 0) console.log(`  Cleanup: removed ${removed} expired MFA session(s).`);
    } catch (error) {
      console.error('  Cleanup failed:', error.message);
    }
  }, 5 * 60 * 1000);

  timer.unref();
  return timer;
}

module.exports = { createApp, startBackgroundCleanup };
