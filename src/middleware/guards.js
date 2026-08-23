'use strict';

/**
 * Route guards.
 *
 * The rule that makes this real MFA: `req.session.userId` is written in exactly
 * one place - after STEP 3 succeeds. Until then the browser only holds an
 * `mfaSessionId`, which grants access to the next authentication step and to
 * nothing else. A user who knows only the password can never reach /dashboard.
 */

const mfaSessionRepo = require('../models/mfaSessionRepo');
const userRepo = require('../models/userRepo');

/** Authentication pages and APIs must never be cached or restored from bfcache. */
function noCache(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
}

/** Wraps an async middleware so a rejected promise reaches the error handler. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/** Loads the in-progress ceremony (if any) and attaches it to the request. */
const loadMfaSession = wrap(async (req, res, next) => {
  req.mfaSession = null;

  const sessionId = req.session ? req.session.mfaSessionId : null;
  if (!sessionId) return next();

  const record = await mfaSessionRepo.findById(sessionId);
  if (!record) {
    delete req.session.mfaSessionId;
    return next();
  }

  // The whole ceremony has a deadline; past it the user must log in again.
  if (mfaSessionRepo.isExpired(record.expires_at) && record.status !== 'completed') {
    delete req.session.mfaSessionId;
    return next();
  }

  req.mfaSession = record;
  return next();
});

const wantsJson = (req) =>
  req.xhr || (req.get('accept') || '').includes('application/json') || req.path.startsWith('/api/');

function deny(req, res, { status, code, message, redirect }) {
  if (wantsJson(req)) {
    return res.status(status).json({ success: false, error: code, message });
  }
  return res.redirect(redirect);
}

/**
 * Requires a live ceremony that has reached at least `stage`.
 * @param {'password'|'otp'} stage
 */
function requireMfaStage(stage) {
  return wrap(async (req, res, next) => {
    const session = req.mfaSession;

    if (!session) {
      return deny(req, res, {
        status: 401,
        code: 'MFA_SESSION_EXPIRED',
        message: 'Your login session has expired. Please sign in again.',
        redirect: '/login?reason=expired',
      });
    }

    if (session.status === 'locked') {
      return deny(req, res, {
        status: 423,
        code: 'MFA_SESSION_LOCKED',
        message: 'This login attempt was locked for security reasons. Please sign in again.',
        redirect: '/login?reason=locked',
      });
    }

    if (!session.password_verified) {
      return deny(req, res, {
        status: 401,
        code: 'PASSWORD_NOT_VERIFIED',
        message: 'Please complete password verification first.',
        redirect: '/login',
      });
    }

    if (stage === 'otp' && !session.otp_verified) {
      return deny(req, res, {
        status: 403,
        code: 'OTP_NOT_VERIFIED',
        message: 'Please complete OTP verification first.',
        redirect: '/verify-otp',
      });
    }

    req.mfaUser = await userRepo.findById(session.user_id);
    if (!req.mfaUser) {
      return deny(req, res, {
        status: 401,
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found. Please sign in again.',
        redirect: '/login',
      });
    }

    return next();
  });
}

/** Guards the dashboard: only a fully completed MFA ceremony gets through. */
const requireAuth = wrap(async (req, res, next) => {
  const isAuthenticated = Boolean(req.session && req.session.userId && req.session.mfaCompleted);

  if (!isAuthenticated) {
    return deny(req, res, {
      status: 401,
      code: 'NOT_AUTHENTICATED',
      message: 'You must complete all three authentication steps first.',
      redirect: '/login?reason=unauthorized',
    });
  }

  const user = await userRepo.findById(req.session.userId);
  if (!user) {
    return req.session.destroy(() => res.redirect('/login?reason=unauthorized'));
  }

  req.user = user;
  return next();
});

/** Sends an already-authenticated visitor straight to the dashboard. */
function redirectIfAuthenticated(req, res, next) {
  if (req.session && req.session.userId && req.session.mfaCompleted) {
    return res.redirect('/dashboard');
  }
  return next();
}

module.exports = { noCache, loadMfaSession, requireMfaStage, requireAuth, redirectIfAuthenticated };
