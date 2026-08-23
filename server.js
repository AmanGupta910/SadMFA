'use strict';

/**
 * GoCart MFA - local entry point.
 *
 * Implementation of Multi-Factor Authentication using three authentication
 * steps: password, one-time password, and email approval.
 *
 * Start with:  npm start
 *
 * On Vercel this file is not used - api/index.js imports the same app and lets
 * the platform handle the listening socket.
 */

const { config, validateConfig } = require('./src/config/env');
const db = require('./src/db');
const { createApp, startBackgroundCleanup } = require('./src/app');
const { verifyTransport } = require('./src/lib/mailer');

validateConfig();

const app = createApp();

const server = app.listen(config.port, async () => {
  try {
    await db.migrate();
  } catch (error) {
    console.error('\n  Could not prepare the database:', error.message, '\n');
    process.exit(1);
  }

  const mail = await verifyTransport();

  console.log('');
  console.log('  ==========================================================');
  console.log('    GoCart - Multi-Factor Authentication Demo');
  console.log('  ==========================================================');
  console.log(`    URL         : ${config.baseUrl}`);
  console.log(`    Environment : ${config.nodeEnv}`);
  console.log(`    Database    : ${db.driver} (${db.location})`);
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

startBackgroundCleanup();

/** Shut down cleanly on Ctrl+C so the database file is never left mid-write. */
function shutdown(signal) {
  console.log(`\n  ${signal} received, shutting down...`);
  server.close(() => {
    db.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
