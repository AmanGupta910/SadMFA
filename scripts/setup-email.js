'use strict';

/**
 * Interactive SMTP setup.   Run:  npm run setup-email
 *
 * Asks for your mail settings in YOUR terminal and writes them straight into
 * .env on this machine. The password is typed with echo turned off and is never
 * printed, logged, or committed (.env is in .gitignore).
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ENV_FILE = path.join(__dirname, '..', '.env');
const EXAMPLE_FILE = path.join(__dirname, '..', '.env.example');

const PROVIDERS = {
  1: { label: 'Gmail',            host: 'smtp.gmail.com',        port: 587, secure: false },
  2: { label: 'Outlook / Hotmail', host: 'smtp-mail.outlook.com', port: 587, secure: false },
  3: { label: 'Yahoo Mail',       host: 'smtp.mail.yahoo.com',   port: 587, secure: false },
  4: { label: 'Brevo (Sendinblue)', host: 'smtp-relay.brevo.com', port: 587, secure: false },
};

/**
 * One shared readline handles all the visible prompts, so input typed ahead is
 * not lost between questions. It is closed before the hidden password prompt -
 * a readline left attached to stdin would echo the password to the screen - and
 * is recreated automatically for any visible prompt that follows.
 */
let sharedRl = null;

function getRl() {
  if (!sharedRl) {
    sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return sharedRl;
}

function closeRl() {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
  }
}

const ask = (question) => new Promise((resolve) => getRl().question(question, (answer) => resolve(answer.trim())));

/** Reads a secret without echoing it to the screen. */
function askHidden(question) {
  return new Promise((resolve) => {
    closeRl(); // nothing else may be reading stdin while the password is typed
    process.stdout.write(question);

    const input = process.stdin;
    const wasRaw = input.isRaw;
    if (input.isTTY) input.setRawMode(true);
    input.resume();

    let value = '';
    let inEscapeSequence = false;

    let finished = false;

    const finish = () => {
      finished = true;
      if (input.isTTY) input.setRawMode(Boolean(wasRaw));
      input.removeListener('data', onData);
      input.pause();
      process.stdout.write('\n');
      resolve(value.trim());
    };

    /**
     * A paste arrives as ONE chunk, and on Windows it usually carries its
     * trailing Enter with it. Comparing the whole chunk against '\r' would miss
     * that Enter and the prompt would hang forever, so every character in the
     * chunk is inspected individually.
     */
    function onData(chunk) {
      const text = chunk.toString('utf8');

      for (const char of text) {
        if (finished) return;

        // Enter / Return - the password is complete.
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }

        // Ctrl+C - abort.
        if (char === '\u0003') {
          if (input.isTTY) input.setRawMode(Boolean(wasRaw));
          process.stdout.write('\n  Cancelled.\n');
          process.exit(1);
        }

        // Backspace / Delete.
        if (char === '\u0008' || char === '\u007f') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }

        // Arrow keys and friends arrive as an ANSI escape sequence such as
        // ESC [ D. Swallow the whole sequence, otherwise the "[D" part would be
        // silently added to the password.
        if (inEscapeSequence) {
          if ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '~') {
            inEscapeSequence = false;
          }
          continue;
        }
        if (char === '\u001b') {
          inEscapeSequence = true;
          continue;
        }

        // Ignore any other control character (Tab, Ctrl+letter, ...).
        if (char < ' ') continue;

        value += char;
        process.stdout.write('*');
      }
    }

    input.on('data', onData);
  });
}

/**
 * Reads the password and sanity-checks its shape before it is saved.
 *
 * Some terminals mangle a paste into a hidden prompt (the characters can be
 * duplicated or joined onto other text), which silently produces a wrong value
 * and a confusing "Username and Password not accepted" much later. Checking the
 * length here turns that into an obvious message straight away.
 */
async function readPassword(isGmail) {
  const MAX_TRIES = 3;

  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    const raw = await askHidden('  Password / App Password (hidden): ');
    const clean = raw.replace(/\s+/g, ''); // Google shows it in 4-character groups

    if (!clean) {
      console.log('  Nothing was entered.\n');
      continue;
    }

    console.log(`  Captured ${clean.length} characters.`);

    if (!isGmail || clean.length === 16) return clean;

    console.log('');
    console.log(`  A Gmail App Password is exactly 16 letters - this is ${clean.length}.`);
    if (clean.length > 16) {
      console.log('  Your terminal probably duplicated the paste. Try TYPING the 16');
      console.log('  letters by hand instead of pasting them.');
    } else {
      console.log('  This looks like your normal Google password, which Gmail refuses.');
      console.log('  Create an App Password at myaccount.google.com/apppasswords');
    }
    console.log('');

    if (attempt === MAX_TRIES) {
      console.log('  Saving it anyway so you can inspect .env by hand.');
      console.log('  You can also edit EMAIL_PASSWORD in .env directly with Notepad.');
      console.log('');
      return clean;
    }

    console.log(`  Attempt ${attempt} of ${MAX_TRIES} - try again.\n`);
  }

  return '';
}

/** Rewrites one KEY=value line, preserving everything else in the file. */
function setEnvValue(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp('^' + key + '=.*$', 'm');
  return pattern.test(contents) ? contents.replace(pattern, line) : contents.trimEnd() + '\n' + line + '\n';
}

async function main() {
  // This command is a conversation. Run from a pipe or a window with no console
  // it would simply hang waiting for input, so say what is wrong instead.
  if (!process.stdin.isTTY) {
    console.error('');
    console.error('  npm run setup-email must be run in an interactive terminal.');
    console.error('  Open PowerShell or Command Prompt in the project folder and run it there.');
    console.error('');
    process.exit(1);
  }

  console.log('');
  console.log('  ==========================================================');
  console.log('    GoCart MFA - Email (SMTP) setup');
  console.log('  ==========================================================');
  console.log('    Your password is typed hidden and saved only to .env');
  console.log('    on this computer. It is never displayed or uploaded.');
  console.log('  ----------------------------------------------------------');
  console.log('');

  if (!fs.existsSync(ENV_FILE)) {
    if (!fs.existsSync(EXAMPLE_FILE)) {
      console.error('  Neither .env nor .env.example was found. Are you in the project folder?');
      process.exit(1);
    }
    fs.copyFileSync(EXAMPLE_FILE, ENV_FILE);
    console.log('  Created .env from .env.example');
  }

  console.log('  Which email provider will SEND the OTP messages?');
  Object.entries(PROVIDERS).forEach(([key, provider]) => {
    console.log(`    ${key}) ${provider.label}`);
  });
  console.log('    5) Something else (enter host and port manually)');
  console.log('');

  const choice = await ask('  Choice [1]: ');
  let host;
  let port;
  let secure;

  if (choice === '5') {
    host = await ask('  SMTP host: ');
    port = Number(await ask('  SMTP port [587]: ')) || 587;
    secure = port === 465;
  } else {
    const provider = PROVIDERS[choice || '1'] || PROVIDERS[1];
    host = provider.host;
    port = provider.port;
    secure = provider.secure;
    console.log(`  Using ${provider.label}: ${host}:${port}`);
  }

  console.log('');
  const user = await ask('  Full email address to send FROM: ');
  if (!user.includes('@')) {
    console.error('\n  That does not look like an email address. Run the command again.\n');
    process.exit(1);
  }

  if (host === 'smtp.gmail.com') {
    console.log('');
    console.log('  Gmail needs an APP PASSWORD, not your normal password:');
    console.log('    1. Turn on 2-Step Verification:  myaccount.google.com/security');
    console.log('    2. Create one here:              myaccount.google.com/apppasswords');
    console.log('    3. Paste the 16-character code below (spaces are fine).');
  }

  console.log('');

  const isGmail = host === 'smtp.gmail.com';
  const cleanPassword = await readPassword(isGmail);

  const displayName = (await ask('  Sender name shown in the inbox [GoCart Security]: ')) || 'GoCart Security';

  let contents = fs.readFileSync(ENV_FILE, 'utf8');
  contents = setEnvValue(contents, 'MAIL_TRANSPORT', 'smtp');
  contents = setEnvValue(contents, 'EMAIL_HOST', host);
  contents = setEnvValue(contents, 'EMAIL_PORT', String(port));
  contents = setEnvValue(contents, 'EMAIL_SECURE', String(secure));
  contents = setEnvValue(contents, 'EMAIL_USER', user);
  contents = setEnvValue(contents, 'EMAIL_PASSWORD', cleanPassword);
  contents = setEnvValue(contents, 'EMAIL_FROM', `"${displayName} <${user}>"`);
  contents = setEnvValue(contents, 'DEMO_MODE', 'false'); // real email now, no on-screen code

  fs.writeFileSync(ENV_FILE, contents, 'utf8');

  console.log('');
  console.log('  Saved to .env');
  console.log(`     MAIL_TRANSPORT = smtp`);
  console.log(`     EMAIL_HOST     = ${host}:${port}`);
  console.log(`     EMAIL_USER     = ${user}`);
  console.log(`     EMAIL_PASSWORD = ${'*'.repeat(cleanPassword.length)} (hidden)`);
  console.log(`     DEMO_MODE      = false`);
  console.log('');
  console.log('  Next step - prove it works:');
  console.log('     npm run test-email');
  console.log('');

  process.exit(0);
}

main().catch((error) => {
  console.error('\n  Setup failed:', error.message, '\n');
  process.exit(1);
});
