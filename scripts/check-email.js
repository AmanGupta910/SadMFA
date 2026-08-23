'use strict';

/**
 * Checks the SMTP credentials only.   Run:  npm run check-email
 *
 * Logs in and immediately disconnects - no message is sent, nothing lands in
 * anybody's inbox. Use it to retry quickly while sorting out an App Password;
 * run `npm run test-email` once this passes to send a real message.
 */

const { config, validateConfig } = require('../src/config/env');
const { verifyTransport } = require('../src/lib/mailer');

async function main() {
  validateConfig();

  const password = String(config.email.password || '');

  console.log('');
  console.log('  ==========================================================');
  console.log('    SMTP credential check (no email is sent)');
  console.log('  ==========================================================');
  console.log(`    Host     : ${config.email.host}:${config.email.port}`);
  console.log(`    User     : ${config.email.user}`);
  console.log(`    Password : ${password.length} characters`);
  console.log('  ----------------------------------------------------------');

  if (config.mailTransport !== 'smtp') {
    console.log('    MAIL_TRANSPORT is not "smtp" - nothing to check.');
    console.log('');
    process.exit(1);
  }

  const started = Date.now();
  const result = await verifyTransport();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (result.ok) {
    console.log(`    LOGIN ACCEPTED  (${seconds}s)`);
    console.log('');
    console.log('    Next:  npm run test-email');
    console.log('');
    process.exit(0);
  }

  console.log(`    LOGIN REJECTED  (${seconds}s)`);
  console.log('');
  console.log(`    ${result.error}`);
  console.log('');

  if (String(result.error).includes('535')) {
    console.log('    Gmail says the username/password pair is wrong. Check, in order:');
    console.log('');
    console.log('    1. The App Password belongs to THIS account.');
    console.log(`       Sign in as ${config.email.user} ONLY (use an incognito window)`);
    console.log('       and open myaccount.google.com/apppasswords');
    console.log('    2. 2-Step Verification is still ON. Turning it off deletes');
    console.log('       every App Password immediately.');
    console.log('    3. The password was not revoked. Delete the old one and');
    console.log('       create a fresh App Password named "GoCart".');
    console.log('    4. It was copied exactly - 16 lowercase letters, no spaces.');
    console.log('       Paste it into .env with Notepad rather than typing it.');
    console.log('');
  }

  process.exit(1);
}

main().catch((error) => {
  console.error('\n  Check failed:', error.message, '\n');
  process.exit(1);
});
