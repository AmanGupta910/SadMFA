'use strict';

/**
 * Starts the server in OFFLINE / TEST mode.   Run:  npm run start:offline
 *
 * Two things change, and only here:
 *   MAIL_TRANSPORT=console  - messages are written to data/outbox/*.html
 *                             instead of being sent, so no SMTP account is needed.
 *   DEMO_MODE=true          - the OTP and the verification link are also shown
 *                             on screen and returned by the API.
 *
 * This exists so `npm test` can read the OTP, and so the project still runs on
 * a machine with no internet. The normal `npm start` uses real email with the
 * codes visible nowhere but the inbox.
 */

process.env.MAIL_TRANSPORT = 'console';
process.env.DEMO_MODE = 'true';
process.env.VERIFY_EMAIL_MX = process.env.VERIFY_EMAIL_MX || 'false';
process.env.ALLOW_TEST_DOMAINS = 'true'; // lets the suite use @example.com

console.log('');
console.log('  ##########################################################');
console.log('  #  OFFLINE / TEST MODE                                   #');
console.log('  #  No real email is sent. The OTP is shown on screen.    #');
console.log('  #  Use `npm start` for the real, secure demo.            #');
console.log('  ##########################################################');

require('../server.js');
