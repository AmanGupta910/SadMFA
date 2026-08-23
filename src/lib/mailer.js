'use strict';

/**
 * Email delivery with two interchangeable transports.
 *
 *   MAIL_TRANSPORT=console -> nothing is sent over the network. Each message is
 *                             printed to the terminal and saved as an .html file
 *                             in data/outbox/, so the whole MFA flow can be
 *                             demonstrated with no SMTP account at all.
 *   MAIL_TRANSPORT=smtp    -> real delivery through the EMAIL_* settings.
 *
 * Nothing in this file contains a credential; everything comes from .env.
 */

const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const { config } = require('../config/env');

const OUTBOX_DIR = path.join(__dirname, '..', '..', 'data', 'outbox');

let smtpTransport = null;

function getSmtpTransport() {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure, // true for port 465, false for 587 (STARTTLS)
      auth: { user: config.email.user, pass: config.email.password },
    });
  }
  return smtpTransport;
}

function safeFileName(value) {
  return String(value).replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
}

/** Writes the message to data/outbox/ and prints a summary to the terminal. */
function deliverToConsole({ to, subject, html, text }) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUTBOX_DIR, `${stamp}__${safeFileName(to)}.html`);
  fs.writeFileSync(file, html, 'utf8');

  console.log('\n==================== EMAIL (console transport) ====================');
  console.log(` To      : ${to}`);
  console.log(` Subject : ${subject}`);
  console.log('-------------------------------------------------------------------');
  console.log(text);
  console.log('-------------------------------------------------------------------');
  console.log(` Saved   : ${file}`);
  console.log('===================================================================\n');

  return { transport: 'console', file };
}

/**
 * Sends one message.
 * Never throws at the call site - a failed email must not crash a login, so the
 * result carries an `ok` flag the route can turn into a friendly message.
 */
async function sendMail({ to, subject, html, text }) {
  try {
    if (config.mailTransport === 'smtp') {
      const info = await getSmtpTransport().sendMail({
        from: config.email.from,
        to,
        subject,
        text,
        html,
      });
      return { ok: true, transport: 'smtp', messageId: info.messageId };
    }

    return { ok: true, ...deliverToConsole({ to, subject, html, text }) };
  } catch (error) {
    // Log the technical detail server-side only; the browser gets a generic message.
    console.error(`\n  EMAIL DELIVERY FAILED -> ${to}`);
    console.error(`     ${error.message}`);
    console.error(`     ${explainSmtpError(error)}\n`);
    return { ok: false, error: 'EMAIL_SEND_FAILED' };
  }
}

/** Turns a raw SMTP failure into a hint that actually tells you what to fix. */
function explainSmtpError(error) {
  const code = error.code || '';
  const text = String(error.message || '').toLowerCase();

  if (code === 'EAUTH' || text.includes('username and password not accepted') || text.includes('invalid login')) {
    return (
      'Authentication rejected. For Gmail you must use a 16-character App Password ' +
      '(not your normal password), and 2-Step Verification must be ON. Run: npm run setup-email'
    );
  }
  if (code === 'ESOCKET' || code === 'ECONNECTION' || code === 'ECONNREFUSED') {
    return 'Could not open a connection. Check EMAIL_HOST / EMAIL_PORT, your internet, and any firewall or college proxy.';
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return 'The mail server did not respond in time. Port 587 is often blocked on college networks - try a mobile hotspot.';
  }
  if (code === 'EENVELOPE') {
    return 'The recipient address was rejected by the mail server. Check the address is real.';
  }
  return 'Check EMAIL_* values in .env, then run: npm run test-email';
}

/** Optional startup check so SMTP problems surface before a demo, not during it. */
async function verifyTransport() {
  if (config.mailTransport !== 'smtp') {
    return { ok: true, transport: 'console' };
  }
  try {
    await getSmtpTransport().verify();
    return { ok: true, transport: 'smtp' };
  } catch (error) {
    return { ok: false, transport: 'smtp', error: error.message };
  }
}

module.exports = { sendMail, verifyTransport, OUTBOX_DIR };
