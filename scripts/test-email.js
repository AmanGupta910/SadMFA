'use strict';

/**
 * Sends one real test message.   Run:  npm run test-email
 *
 * Use this before a demo: it proves the SMTP settings in .env actually work,
 * so you find out about a wrong password now rather than in front of the class.
 */

const { config, validateConfig } = require('../src/config/env');
const { sendMail, verifyTransport } = require('../src/lib/mailer');
const { checkDeliverable } = require('../src/lib/emailDeliverability');
const emailTemplates = require('../src/lib/emailTemplates');

async function main() {
  validateConfig();

  const recipient = process.argv[2] || config.email.user;

  console.log('');
  console.log('  ==========================================================');
  console.log('    GoCart MFA - email delivery test');
  console.log('  ==========================================================');
  console.log(`    Transport : ${config.mailTransport}`);
  console.log(`    Host      : ${config.email.host}:${config.email.port}`);
  console.log(`    From      : ${config.email.from}`);
  console.log(`    To        : ${recipient}`);
  console.log('  ----------------------------------------------------------');

  if (config.mailTransport !== 'smtp') {
    console.log('');
    console.log('  MAIL_TRANSPORT is not "smtp", so nothing will be sent over');
    console.log('  the network. Run:  npm run setup-email');
    console.log('');
    process.exit(1);
  }

  // 0. Is the stored password even the right shape? A Gmail App Password is
  //    exactly 16 letters; anything else is a mangled paste or the wrong
  //    password, and SMTP would only report a vague "credentials rejected".
  if (config.email.host === 'smtp.gmail.com') {
    const stored = String(config.email.password || '');
    if (stored.length !== 16) {
      console.log('');
      console.log(`  EMAIL_PASSWORD is ${stored.length} characters, but a Gmail`);
      console.log('  App Password is exactly 16 lowercase letters.');
      console.log('');
      console.log('  Fix it either way:');
      console.log('    - run  npm run setup-email  and TYPE the 16 letters, or');
      console.log('    - open .env in Notepad and set EMAIL_PASSWORD by hand.');
      console.log('');
      process.exit(1);
    }
    console.log('    [0/2] App Password is 16 characters ........... OK');
  }

  // 1. Can the recipient domain even receive mail?
  const deliverable = await checkDeliverable(String(recipient).toLowerCase());
  if (!deliverable.ok) {
    console.log('');
    console.log(`  Recipient rejected: ${deliverable.message}`);
    console.log('');
    process.exit(1);
  }
  console.log('    [1/2] Recipient domain has a mail server ....... OK');

  // 2. Do the credentials work?
  const transport = await verifyTransport();
  if (!transport.ok) {
    console.log('    [2/2] SMTP login .............................. FAILED');
    console.log('');
    console.log(`  ${transport.error}`);
    console.log('');
    console.log('  Most common cause with Gmail: using the normal account');
    console.log('  password instead of a 16-character App Password.');
    console.log('  Fix it with:  npm run setup-email');
    console.log('');
    process.exit(1);
  }
  console.log('    [2/2] SMTP login .............................. OK');

  // 3. Send a message that looks exactly like the real OTP mail.
  const result = await sendMail({
    to: recipient,
    ...emailTemplates.otpEmail({ name: 'GoCart Test', otp: '123456' }),
  });

  console.log('  ----------------------------------------------------------');
  if (result.ok) {
    console.log('    Message accepted by the mail server.');
    console.log(`    Check the inbox of ${recipient} (also look in Spam).`);
    console.log('');
    console.log('    Note: 123456 above is a sample, not a live code.');
  } else {
    console.log('    Sending failed - see the error printed above.');
    process.exitCode = 1;
  }
  console.log('  ==========================================================');
  console.log('');
}

main().catch((error) => {
  console.error('\n  Test failed:', error.message, '\n');
  process.exit(1);
});
