'use strict';

/**
 * Page routes - render the HTML screens.
 *
 * Each page is protected by the same guards as the matching API endpoint, so a
 * user cannot skip a step just by typing a URL into the address bar.
 */

const express = require('express');

const { config } = require('../config/env');
const { maskEmail } = require('../lib/validators');
const mfaSessionRepo = require('../models/mfaSessionRepo');
const audit = require('../models/auditRepo');
const { noCache, loadMfaSession, requireMfaStage, requireAuth, redirectIfAuthenticated } = require('../middleware/guards');

const router = express.Router();
router.use(noCache);
router.use(loadMfaSession);

/** Wraps an async handler so a rejected promise reaches the error middleware. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/** Friendly banner text for the ?reason= / ?registered= query flags on /login. */
const LOGIN_NOTICES = {
  expired: { type: 'warning', text: 'Your login session expired. Please sign in again.' },
  locked: { type: 'error', text: 'That login attempt was locked for security reasons. Please sign in again.' },
  otp_locked: { type: 'error', text: 'Too many incorrect OTP attempts. Please sign in again.' },
  resend_limit: { type: 'error', text: 'Resend limit reached. Please start a new login.' },
  unauthorized: { type: 'error', text: 'Please complete all three authentication steps to reach the dashboard.' },
  logged_out: { type: 'success', text: 'You have been logged out successfully.' },
};

// --------------------------------------------------------------------------
router.get('/', (req, res) => {
  if (req.session && req.session.userId && req.session.mfaCompleted) return res.redirect('/dashboard');
  return res.redirect('/login');
});

// --------------------------------------------------------------------------
router.get('/register', redirectIfAuthenticated, (req, res) => {
  res.render('register', { title: 'Register | GoCart Security', notice: null });
});

// --------------------------------------------------------------------------
router.get('/login', redirectIfAuthenticated, (req, res) => {
  let notice = LOGIN_NOTICES[String(req.query.reason || '')] || null;
  if (req.query.registered === '1') {
    notice = { type: 'success', text: 'Account created successfully. Please sign in.' };
  }
  res.render('login', { title: 'Sign In | GoCart Security', notice });
});

// --------------------------------------------------------------------------
// STEP 2 page - reachable only once the password has been verified.
router.get('/verify-otp', requireMfaStage('password'), (req, res) => {
  const session = req.mfaSession;

  if (session.otp_verified) return res.redirect('/verify-email');

  const secondsLeft = session.otp_expires_at
    ? Math.max(0, Math.floor((new Date(session.otp_expires_at).getTime() - Date.now()) / 1000))
    : 0;

  res.render('verify-otp', {
    title: 'Verify OTP | GoCart Security',
    maskedEmail: maskEmail(req.mfaUser.email),
    otpLength: config.otpLength,
    secondsLeft,
    attemptsRemaining: Math.max(0, config.otpMaxAttempts - session.otp_attempts),
    maxAttempts: config.otpMaxAttempts,
    resendCooldown: config.otpResendCooldownSeconds,
  });
});

// --------------------------------------------------------------------------
// STEP 3 page - reachable only once the OTP has been verified.
router.get('/verify-email', requireMfaStage('otp'), (req, res) => {
  const session = req.mfaSession;

  if (session.mfa_completed) {
    req.session.userId = session.user_id;
    req.session.mfaCompleted = true;
    return res.redirect('/dashboard');
  }

  res.render('verify-email', {
    title: 'Email Verification | GoCart Security',
    email: req.mfaUser.email,
    tokenTtlMinutes: config.emailTokenTtlMinutes,
    resendCooldown: config.emailResendCooldownSeconds,
    alreadySent: Boolean(session.email_last_sent_at),
  });
});

// --------------------------------------------------------------------------
// The protected destination. Guarded by requireAuth, which only passes when
// req.session.userId AND req.session.mfaCompleted are set - i.e. after STEP 3.
router.get(
  '/dashboard',
  requireAuth,
  wrap(async (req, res) => {
    const session = req.session.mfaSessionId ? await mfaSessionRepo.findById(req.session.mfaSessionId) : null;
    const recentEvents = await audit.recentForUser(req.user.id, 8);

    res.render('dashboard', {
      title: 'Dashboard | GoCart Security',
      user: { id: req.user.id, name: req.user.name, email: req.user.email },
      completedAt: session ? session.updated_at : null,
      recentEvents,
    });
  })
);

// A second dummy page, so the "Go to Store Dashboard" button leads somewhere.
router.get('/store', requireAuth, (req, res) => {
  res.render('store', {
    title: 'Store | GoCart',
    user: { id: req.user.id, name: req.user.name, email: req.user.email },
  });
});

module.exports = router;
