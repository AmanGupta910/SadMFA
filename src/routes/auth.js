'use strict';

/**
 * Authentication API - /api/auth/*
 *
 * The three factors:
 *   STEP 1  POST /api/auth/login                   password (something you know)
 *   STEP 2  POST /api/auth/verify-otp              6-digit code emailed to you
 *   STEP 3  GET  /api/auth/verify-email?token=...  "YES, IT'S ME" approval link
 *
 * The logged-in session is created at the end of STEP 3 and nowhere else.
 */

const express = require('express');

const { config } = require('../config/env');
const userRepo = require('../models/userRepo');
const mfaSessionRepo = require('../models/mfaSessionRepo');
const audit = require('../models/auditRepo');

const { hashPassword, verifyPassword, wasteTimeLikeARealCheck } = require('../lib/password');
const { generateOtp, hashOtp, verifyOtp, isWellFormedOtp } = require('../lib/otp');
const { generateEmailToken, hashEmailToken, isWellFormedToken } = require('../lib/tokens');
const { validateRegistration, validateEmail, maskEmail } = require('../lib/validators');
const { checkDeliverable } = require('../lib/emailDeliverability');
const { sendMail } = require('../lib/mailer');
const emailTemplates = require('../lib/emailTemplates');
const rateLimit = require('../lib/rateLimit');
const { noCache, loadMfaSession, requireMfaStage } = require('../middleware/guards');

const router = express.Router();
router.use(noCache);
router.use(loadMfaSession);

const clientIp = (req) => req.ip || req.socket.remoteAddress || 'unknown';

const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, error: code, message, ...extra });

/** Wraps an async handler so a rejected promise reaches the error middleware. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// ===========================================================================
// REGISTRATION
// ===========================================================================
router.post(
  '/register',
  wrap(async (req, res) => {
    const { name, email, password, confirmPassword } = req.body || {};

    // 1. Server-side validation of every field.
    const check = validateRegistration({ name, email, password, confirmPassword });
    if (!check.ok) {
      return fail(res, 400, 'VALIDATION_ERROR', check.message, { field: check.field });
    }

    // Light throttle so the form cannot be scripted to create endless accounts.
    const limit = rateLimit.hit(`register:${clientIp(req)}`, { max: 10, windowMs: 15 * 60000 });
    if (!limit.allowed) {
      return fail(res, 429, 'TOO_MANY_REQUESTS', 'Too many registration attempts. Please try again later.');
    }

    // 2. Reject a duplicate email.
    if (userRepo.emailExists(check.value.email)) {
      return fail(res, 409, 'EMAIL_EXISTS', 'An account with this email address already exists. Please log in instead.', {
        field: 'email',
      });
    }

    // 2b. The address must be able to RECEIVE mail, because both the OTP and the
    //     "YES, IT'S ME" link are delivered there. A well-formed but undeliverable
    //     address (example.com, a typo, a throw-away inbox) would make the account
    //     impossible to log into, so it is refused up front.
    const deliverable = await checkDeliverable(check.value.email);
    if (!deliverable.ok) {
      return fail(res, 400, 'EMAIL_NOT_DELIVERABLE', deliverable.message, { field: 'email' });
    }

    // 3. Hash the password - the plain text is never written anywhere.
    const passwordHash = await hashPassword(check.value.password);

    // 4. / 5. Create the account with its MFA fields initialised.
    const user = userRepo.createUser({
      name: check.value.name,
      email: check.value.email,
      passwordHash,
    });

    audit.record({ userId: user.id, event: 'USER_REGISTERED', ipAddress: clientIp(req) });

    // 6. The browser is told to go to the login page. No session is created here:
    //    registering does not log you in, you must still pass all three factors.
    return res.status(201).json({
      success: true,
      message: 'Account created successfully. Please log in.',
      redirect: '/login?registered=1',
      user: userRepo.toPublicUser(user),
    });
  })
);

// ===========================================================================
// STEP 1 - PASSWORD VERIFICATION
// ===========================================================================
router.post(
  '/login',
  wrap(async (req, res) => {
    const { email, password } = req.body || {};

    const emailCheck = validateEmail(email);
    if (!emailCheck.ok) return fail(res, 400, 'VALIDATION_ERROR', emailCheck.message, { field: 'email' });
    if (!password) return fail(res, 400, 'VALIDATION_ERROR', 'Please enter your password.', { field: 'password' });

    // Brute-force protection, keyed on both the account and the source IP.
    const key = `login:${emailCheck.value}:${clientIp(req)}`;
    const limit = rateLimit.hit(key, {
      max: config.loginMaxAttempts,
      windowMs: config.loginWindowMinutes * 60000,
    });
    if (!limit.allowed) {
      audit.record({ event: 'LOGIN_RATE_LIMITED', detail: emailCheck.value, ipAddress: clientIp(req) });
      return fail(
        res,
        429,
        'TOO_MANY_ATTEMPTS',
        `Too many failed login attempts. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`
      );
    }

    const user = userRepo.findByEmail(emailCheck.value);

    // Same generic message and similar timing whether the email exists or not,
    // so the endpoint cannot be used to discover which emails are registered.
    if (!user) {
      await wasteTimeLikeARealCheck();
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    const passwordOk = await verifyPassword(password, user.password_hash);
    if (!passwordOk) {
      audit.record({ userId: user.id, event: 'LOGIN_PASSWORD_FAILED', ipAddress: clientIp(req) });
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    rateLimit.reset(key);

    // Password accepted -> open a TEMPORARY ceremony. This is not a login session:
    // it carries no userId, so it unlocks nothing except the next MFA step.
    const mfaSession = mfaSessionRepo.createSession({
      userId: user.id,
      ipAddress: clientIp(req),
      userAgent: req.get('user-agent'),
    });
    mfaSessionRepo.expireOtherPendingSessions(user.id, mfaSession.id);

    // Generate and email the first OTP (STEP 2).
    const otp = generateOtp();
    const otpHash = await hashOtp(otp);
    mfaSessionRepo.setOtp(mfaSession.id, { otpHash, resendCount: 0 });

    const mail = await sendMail({
      to: user.email,
      ...emailTemplates.otpEmail({ name: user.name, otp }),
    });

    audit.record({
      userId: user.id,
      mfaSessionId: mfaSession.id,
      event: 'LOGIN_PASSWORD_OK',
      detail: mail.ok ? 'otp_sent' : 'otp_send_failed',
      ipAddress: clientIp(req),
    });

    // If the code could not be delivered there is no point sending the user to
    // the OTP screen - they would be stuck waiting for an email that never
    // arrives. Abandon this attempt and say so plainly.
    if (!mail.ok) {
      mfaSessionRepo.lockSession(mfaSession.id, 'locked');
      return fail(
        res,
        502,
        'EMAIL_SEND_FAILED',
        'We could not send the verification code to your email right now. Please try again in a moment.'
      );
    }

    // Regenerate the cookie session id to prevent session fixation.
    return req.session.regenerate((error) => {
      if (error) return fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');

      req.session.mfaSessionId = mfaSession.id;
      req.session.pendingEmail = user.email;
      req.session.pendingName = user.name;

      return res.json({
        success: true,
        message: 'Password verified. A one-time password has been sent to your email.',
        redirect: '/verify-otp',
        step: 2,
        maskedEmail: maskEmail(user.email),
        emailSent: mail.ok,
        expiresInSeconds: config.otpTtlMinutes * 60,
        // Demo-only echo, impossible in production (see config.demoMode).
        ...(config.demoMode ? { demoOtp: otp } : {}),
      });
    });
  })
);

// ===========================================================================
// STEP 2 - OTP VERIFICATION
// ===========================================================================
router.post(
  '/verify-otp',
  requireMfaStage('password'),
  wrap(async (req, res) => {
    const session = req.mfaSession;
    const user = req.mfaUser;
    const submitted = String((req.body && req.body.otp) || '').trim();

    if (session.otp_verified) {
      return res.json({ success: true, message: 'OTP already verified.', redirect: '/verify-email', step: 3 });
    }

    if (!isWellFormedOtp(submitted)) {
      return fail(res, 400, 'INVALID_OTP_FORMAT', `Please enter the ${config.otpLength}-digit code.`, {
        attemptsRemaining: Math.max(0, config.otpMaxAttempts - session.otp_attempts),
      });
    }

    // Attempt limit - stops an attacker simply trying all million combinations.
    if (session.otp_attempts >= config.otpMaxAttempts) {
      mfaSessionRepo.lockSession(session.id, 'locked');
      audit.record({ userId: user.id, mfaSessionId: session.id, event: 'OTP_LOCKED', ipAddress: clientIp(req) });
      return fail(res, 429, 'TOO_MANY_OTP_ATTEMPTS', 'Too many incorrect attempts. Please sign in again.', {
        redirect: '/login?reason=otp_locked',
      });
    }

    if (!session.otp_hash || mfaSessionRepo.isExpired(session.otp_expires_at)) {
      return fail(res, 410, 'OTP_EXPIRED', 'This OTP has expired. Please request a new code.', {
        attemptsRemaining: Math.max(0, config.otpMaxAttempts - session.otp_attempts),
      });
    }

    const matches = await verifyOtp(submitted, session.otp_hash);

    if (!matches) {
      const updated = mfaSessionRepo.incrementOtpAttempts(session.id);
      const attemptsRemaining = Math.max(0, config.otpMaxAttempts - updated.otp_attempts);

      audit.record({
        userId: user.id,
        mfaSessionId: session.id,
        event: 'OTP_FAILED',
        detail: `attempt ${updated.otp_attempts}/${config.otpMaxAttempts}`,
        ipAddress: clientIp(req),
      });

      if (attemptsRemaining === 0) {
        mfaSessionRepo.lockSession(session.id, 'locked');
        return fail(res, 429, 'TOO_MANY_OTP_ATTEMPTS', 'Too many incorrect attempts. Please sign in again.', {
          attemptsRemaining: 0,
          redirect: '/login?reason=otp_locked',
        });
      }

      return fail(res, 401, 'INVALID_OTP', 'Invalid or Expired OTP. Please try again.', {
        attemptsRemaining,
        maxAttempts: config.otpMaxAttempts,
      });
    }

    // Correct -> burn the OTP so the same code can never be replayed.
    mfaSessionRepo.markOtpVerified(session.id);
    audit.record({ userId: user.id, mfaSessionId: session.id, event: 'OTP_VERIFIED', ipAddress: clientIp(req) });

    return res.json({
      success: true,
      message: 'OTP verified successfully.',
      redirect: '/verify-email',
      step: 3,
    });
  })
);

// ===========================================================================
// STEP 2 - RESEND OTP
// ===========================================================================
router.post(
  '/resend-otp',
  requireMfaStage('password'),
  wrap(async (req, res) => {
    const session = req.mfaSession;
    const user = req.mfaUser;

    if (session.otp_verified) {
      return fail(res, 400, 'OTP_ALREADY_VERIFIED', 'This step is already complete.', { redirect: '/verify-email' });
    }

    // Cooldown so the resend link cannot be used to spam the user's inbox.
    if (session.otp_last_sent_at) {
      const elapsedSeconds = (Date.now() - new Date(session.otp_last_sent_at).getTime()) / 1000;
      if (elapsedSeconds < config.otpResendCooldownSeconds) {
        const waitSeconds = Math.ceil(config.otpResendCooldownSeconds - elapsedSeconds);
        return fail(res, 429, 'RESEND_COOLDOWN', `Please wait ${waitSeconds} second(s) before requesting a new code.`, {
          retryAfterSeconds: waitSeconds,
        });
      }
    }

    if (session.otp_resend_count >= config.otpMaxResends) {
      return fail(res, 429, 'RESEND_LIMIT_REACHED', 'Resend limit reached for this login attempt. Please sign in again.', {
        redirect: '/login?reason=resend_limit',
      });
    }

    // A brand new code replaces the old hash, so the previous OTP stops working.
    const otp = generateOtp();
    const otpHash = await hashOtp(otp);
    mfaSessionRepo.setOtp(session.id, { otpHash, resendCount: session.otp_resend_count + 1 });

    const mail = await sendMail({ to: user.email, ...emailTemplates.otpEmail({ name: user.name, otp }) });

    if (!mail.ok) {
      audit.record({ userId: user.id, mfaSessionId: session.id, event: 'OTP_RESEND_FAILED', ipAddress: clientIp(req) });
      return fail(res, 502, 'EMAIL_SEND_FAILED', 'We could not send the email right now. Please try again in a moment.');
    }

    audit.record({ userId: user.id, mfaSessionId: session.id, event: 'OTP_RESENT', ipAddress: clientIp(req) });

    return res.json({
      success: true,
      message: 'A new one-time password has been sent to your email.',
      expiresInSeconds: config.otpTtlMinutes * 60,
      resendsRemaining: config.otpMaxResends - (session.otp_resend_count + 1),
      ...(config.demoMode ? { demoOtp: otp } : {}),
    });
  })
);

// ===========================================================================
// STEP 3 - SEND / RESEND THE "YES, IT'S ME" EMAIL
// ===========================================================================
async function issueVerificationEmail(session, user) {
  const token = generateEmailToken(); // 256-bit random value
  const tokenHash = hashEmailToken(token); // only the hash is stored
  mfaSessionRepo.setEmailToken(session.id, { tokenHash, resendCount: session.email_resend_count + 1 });

  const verifyUrl = `${config.baseUrl}/api/auth/verify-email?token=${token}`;

  const mail = await sendMail({
    to: user.email,
    ...emailTemplates.loginApprovalEmail({
      name: user.name,
      verifyUrl,
      ipAddress: session.ip_address,
      when: new Date().toLocaleString(),
    }),
  });

  return { mail, verifyUrl };
}

router.post(
  '/send-email-verification',
  requireMfaStage('otp'),
  wrap(async (req, res) => {
    const session = req.mfaSession;
    const user = req.mfaUser;

    if (session.email_verified) {
      return res.json({ success: true, message: 'Email already verified.', redirect: '/dashboard' });
    }

    const isResend = Boolean(session.email_last_sent_at);

    if (isResend) {
      const elapsedSeconds = (Date.now() - new Date(session.email_last_sent_at).getTime()) / 1000;
      if (elapsedSeconds < config.emailResendCooldownSeconds) {
        const waitSeconds = Math.ceil(config.emailResendCooldownSeconds - elapsedSeconds);
        return fail(res, 429, 'RESEND_COOLDOWN', `Please wait ${waitSeconds} second(s) before resending.`, {
          retryAfterSeconds: waitSeconds,
        });
      }
    }

    if (session.email_resend_count >= config.otpMaxResends + 2) {
      return fail(res, 429, 'RESEND_LIMIT_REACHED', 'Resend limit reached. Please sign in again.', {
        redirect: '/login?reason=resend_limit',
      });
    }

    const { mail, verifyUrl } = await issueVerificationEmail(session, user);

    if (!mail.ok) {
      audit.record({ userId: user.id, mfaSessionId: session.id, event: 'EMAIL_VERIFY_SEND_FAILED' });
      return fail(res, 502, 'EMAIL_SEND_FAILED', 'We could not send the verification email. Please try again in a moment.');
    }

    audit.record({
      userId: user.id,
      mfaSessionId: session.id,
      event: isResend ? 'EMAIL_VERIFY_RESENT' : 'EMAIL_VERIFY_SENT',
      ipAddress: clientIp(req),
    });

    return res.json({
      success: true,
      message: 'Verification email sent. Please check your inbox.',
      expiresInSeconds: config.emailTokenTtlMinutes * 60,
      cooldownSeconds: config.emailResendCooldownSeconds,
      ...(config.demoMode ? { demoVerifyUrl: verifyUrl } : {}),
    });
  })
);

// ===========================================================================
// STEP 3 - THE LINK ITSELF ("YES, IT'S ME")
// ===========================================================================
// GET, because it is opened from an email client. It renders a page rather than
// returning JSON, and it works even if opened in a different browser: the DB row
// is marked verified, and the tab waiting on /verify-email picks that up.
router.get(
  '/verify-email',
  wrap(async (req, res) => {
    const token = String(req.query.token || '').trim();

    const rejectWith = (reasonCode, heading, message) =>
      res.status(400).render('verify-email-failed', {
        title: 'Verification Failed | GoCart Security',
        reasonCode,
        heading,
        message,
      });

    if (!isWellFormedToken(token)) {
      return rejectWith(
        'INVALID_TOKEN',
        'Invalid Verification Link',
        'This verification link is not valid. Please sign in again to request a new one.'
      );
    }

    // Look the ceremony up by the HASH - the raw token is never stored.
    const session = mfaSessionRepo.findByEmailTokenHash(hashEmailToken(token));

    if (!session) {
      // Covers: never existed, already used (hash cleared), or superseded.
      return rejectWith(
        'INVALID_OR_USED_TOKEN',
        'Link Already Used or Invalid',
        'This verification link has already been used or is no longer valid. Please sign in again.'
      );
    }

    if (session.status === 'locked') {
      return rejectWith(
        'SESSION_LOCKED',
        'Login Attempt Locked',
        'This login attempt was locked for security reasons. Please sign in again.'
      );
    }

    if (mfaSessionRepo.isExpired(session.email_token_expires_at)) {
      return rejectWith(
        'TOKEN_EXPIRED',
        'Verification Link Expired',
        `This link expired after ${config.emailTokenTtlMinutes} minutes. Please sign in again to receive a new one.`
      );
    }

    if (mfaSessionRepo.isExpired(session.expires_at)) {
      return rejectWith('SESSION_EXPIRED', 'Login Session Expired', 'Your login session has expired. Please sign in again.');
    }

    // Order matters: STEP 3 is only valid once STEPS 1 and 2 have passed.
    if (!session.password_verified || !session.otp_verified) {
      return rejectWith(
        'STEPS_INCOMPLETE',
        'Earlier Steps Not Complete',
        'Password and OTP verification must be completed before this step.'
      );
    }

    const user = userRepo.findById(session.user_id);
    if (!user) {
      return rejectWith('ACCOUNT_NOT_FOUND', 'Account Not Found', 'We could not find the account for this link.');
    }

    // Valid -> burn the token, mark the ceremony complete.
    mfaSessionRepo.markEmailVerifiedAndComplete(session.id);
    userRepo.markEmailVerified(user.id);
    audit.record({ userId: user.id, mfaSessionId: session.id, event: 'EMAIL_VERIFIED', ipAddress: clientIp(req) });
    audit.record({ userId: user.id, mfaSessionId: session.id, event: 'MFA_COMPLETED', ipAddress: clientIp(req) });

    // If the link was opened in the SAME browser that started the login, upgrade
    // this cookie into a real authenticated session right away.
    const sameBrowser = Boolean(req.session && req.session.mfaSessionId === session.id);
    if (sameBrowser) {
      req.session.userId = user.id;
      req.session.mfaCompleted = true;
    }

    return res.render('verify-email-success', {
      title: 'Email Verified | GoCart Security',
      sameBrowser,
    });
  })
);

// ===========================================================================
// POLLING - lets the waiting tab notice that the emailed link was clicked
// ===========================================================================
router.get(
  '/mfa-status',
  wrap(async (req, res) => {
    const session = req.mfaSession;

    if (!session) {
      return res.status(401).json({ success: false, error: 'MFA_SESSION_EXPIRED', authenticated: false });
    }

    const progress = mfaSessionRepo.toProgress(session);

    // The email link may have been clicked in a different browser or on a phone.
    // Once the database says the ceremony is complete, this tab can be logged in.
    if (progress.mfaCompleted && !(req.session.userId && req.session.mfaCompleted)) {
      req.session.userId = session.user_id;
      req.session.mfaCompleted = true;
    }

    return res.json({ success: true, ...progress, redirect: progress.mfaCompleted ? '/dashboard' : null });
  })
);

// ===========================================================================
// LOGOUT
// ===========================================================================
router.post(
  '/logout',
  wrap(async (req, res) => {
    const userId = req.session ? req.session.userId : null;
    if (userId) audit.record({ userId, event: 'LOGOUT', ipAddress: clientIp(req) });

    return req.session.destroy((error) => {
      if (error) return fail(res, 500, 'SERVER_ERROR', 'Could not log out. Please try again.');
      res.clearCookie('gocart.sid');
      return res.json({ success: true, message: 'You have been logged out.', redirect: '/login?reason=logged_out' });
    });
  })
);

module.exports = router;
