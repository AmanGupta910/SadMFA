'use strict';

/** HTML + plain-text bodies for the two emails the MFA flow sends. */

const { config } = require('../config/env');

/** Escapes user-controlled text before it is placed inside HTML. */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BRAND = '#1c4587';
const SHELL_OPEN = `
<div style="margin:0;padding:24px 12px;background:#eef1f5;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
    <tr>
      <td style="background:${BRAND};padding:18px 24px;text-align:center;">
        <span style="color:#ffffff;font-size:24px;font-weight:700;letter-spacing:0.3px;">GoCart</span>
      </td>
    </tr>
    <tr><td style="padding:28px 28px 8px 28px;color:#1f2937;">`;

const shellClose = () => `
    </td></tr>
    <tr>
      <td style="padding:18px 28px 24px 28px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.6;">
        This is an automated security message from GoCart.<br>
        &copy; ${new Date().getFullYear()} GoCart Technologies
      </td>
    </tr>
  </table>
</div>`;

/** STEP 2 email - delivers the 6-digit one-time password. */
function otpEmail({ name, otp }) {
  const safeName = escapeHtml(name);
  const safeOtp = escapeHtml(otp);

  const html = `${SHELL_OPEN}
    <h2 style="margin:0 0 6px 0;font-size:20px;color:${BRAND};">Your GoCart verification code</h2>
    <p style="margin:0 0 18px 0;font-size:14px;color:#6b7280;">Step 2 of 3: Possession Verification</p>
    <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">Hello ${safeName},</p>
    <p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;">
      Use the one-time password below to continue signing in to your GoCart account.
    </p>
    <div style="margin:0 0 20px 0;text-align:center;">
      <div style="display:inline-block;padding:14px 28px;background:#f3f6fa;border:1px solid #d5deea;border-radius:8px;
                  font-size:32px;font-weight:700;letter-spacing:10px;color:${BRAND};">${safeOtp}</div>
    </div>
    <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;">
      This code expires in <strong>${config.otpTtlMinutes} minutes</strong> and can be used only once.
    </p>
    <p style="margin:0 0 4px 0;font-size:14px;line-height:1.6;color:#6b7280;">
      If you did not try to sign in, you can safely ignore this email - your password is still required.
    </p>
  ${shellClose()}`;

  const text = [
    `Hello ${name},`,
    '',
    `Your GoCart verification code is: ${otp}`,
    '',
    `It expires in ${config.otpTtlMinutes} minutes and can be used only once.`,
    'If you did not try to sign in, you can ignore this email.',
  ].join('\n');

  return { subject: `${otp} is your GoCart verification code`, html, text };
}

/** STEP 3 email - the "YES, IT'S ME" approval link. */
function loginApprovalEmail({ name, verifyUrl, ipAddress, when }) {
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(verifyUrl);
  const safeIp = escapeHtml(ipAddress || 'unknown');
  const safeWhen = escapeHtml(when);

  const html = `${SHELL_OPEN}
    <h2 style="margin:0 0 6px 0;font-size:20px;color:${BRAND};">GoCart Security</h2>
    <p style="margin:0 0 18px 0;font-size:14px;color:#6b7280;">Step 3 of 3: Email Verification</p>
    <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">Hello ${safeName},</p>
    <p style="margin:0 0 18px 0;font-size:15px;line-height:1.6;">
      A login attempt was made on your account. If this was you, click the button below to finish signing in.
    </p>
    <div style="margin:0 0 22px 0;text-align:center;">
      <a href="${safeUrl}"
         style="display:inline-block;padding:14px 34px;background:${BRAND};color:#ffffff;text-decoration:none;
                border-radius:6px;font-size:16px;font-weight:600;letter-spacing:0.4px;">YES, IT'S ME</a>
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
           style="margin:0 0 18px 0;background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;">
      <tr><td style="padding:12px 14px;font-size:13px;color:#4b5563;line-height:1.7;">
        <strong>Time:</strong> ${safeWhen}<br>
        <strong>IP address:</strong> ${safeIp}
      </td></tr>
    </table>
    <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;">
      This link expires in <strong>${config.emailTokenTtlMinutes} minutes</strong> and can be used only once.
    </p>
    <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#b91c1c;">
      If you did not initiate this login, ignore this email and secure your account by changing your password.
    </p>
    <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;word-break:break-all;">
      Button not working? Paste this address into your browser:<br>${safeUrl}
    </p>
  ${shellClose()}`;

  const text = [
    'GoCart Security',
    '',
    `Hello ${name},`,
    '',
    'A login attempt was made on your account.',
    'If this was you, open the link below to confirm ("YES, IT\'S ME"):',
    '',
    verifyUrl,
    '',
    `Time: ${when}`,
    `IP address: ${ipAddress || 'unknown'}`,
    '',
    `This link expires in ${config.emailTokenTtlMinutes} minutes and can be used only once.`,
    'If you did not initiate this login, ignore this email and secure your account.',
  ].join('\n');

  return { subject: 'Confirm your GoCart login - Is this you?', html, text };
}

module.exports = { otpEmail, loginApprovalEmail, escapeHtml };
