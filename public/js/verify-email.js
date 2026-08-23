/* MFA STEP 3 - email approval.
   This page sends the "YES, IT'S ME" email, then polls /api/auth/mfa-status
   until the link is clicked. Polling means the link also works when it is
   opened in another browser or on a phone. */
(function () {
  'use strict';

  const card = document.querySelector('.card');
  const alertBox = document.getElementById('formAlert');
  const infoBox = document.getElementById('infoAlert');
  const resendBtn = document.getElementById('resendBtn');
  const statusLine = document.getElementById('statusLine');
  const demoPanel = document.getElementById('demoPanel');
  const demoLink = document.getElementById('demoLink');

  const resendCooldown = Number(card.dataset.resendCooldown) || 60;

  const POLL_INTERVAL_MS = 2500;
  const MAX_POLL_MINUTES = Number(card.dataset.ttlMinutes) || 15;
  const pollDeadline = Date.now() + MAX_POLL_MINUTES * 60 * 1000;

  let pollTimer = null;

  function lockResend(seconds) {
    resendBtn.disabled = true;
    GoCart.startCountdown(
      seconds,
      function (remaining) {
        resendBtn.textContent = 'Resend Verification Email  ' + GoCart.formatClock(remaining);
      },
      function () {
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend Verification Email';
      }
    );
  }

  function showDemoLink(url) {
    if (!demoPanel || !demoLink || !url) return;
    demoLink.href = url;
    demoPanel.hidden = false;
  }

  /** Asks the server to issue and send a verification token. */
  async function sendVerificationEmail(isManualResend) {
    GoCart.hideAlert(alertBox);
    resendBtn.disabled = true;
    resendBtn.textContent = 'Sending...';

    try {
      const result = await GoCart.postJson('/api/auth/send-email-verification', {});

      if (result.data.success) {
        if (result.data.redirect) {
          window.location.href = result.data.redirect;
          return;
        }

        if (isManualResend) {
          GoCart.showAlert(infoBox, 'Verification email sent again. Please check your inbox.', 'success');
        }

        if (result.data.demoVerifyUrl) showDemoLink(result.data.demoVerifyUrl);
        lockResend(result.data.cooldownSeconds || resendCooldown);
        return;
      }

      if (result.data.redirect) {
        window.location.href = result.data.redirect;
        return;
      }

      GoCart.showAlert(alertBox, result.data.message || 'Could not send the verification email.', 'error');
      lockResend(result.data.retryAfterSeconds || resendCooldown);
    } catch (error) {
      GoCart.showAlert(alertBox, 'Could not reach the server. Please check your connection.', 'error');
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend Verification Email';
    }
  }

  /** Polls until the emailed link has been clicked. */
  async function poll() {
    if (Date.now() > pollDeadline) {
      clearInterval(pollTimer);
      statusLine.textContent = 'This login attempt has expired. Please sign in again.';
      GoCart.showAlert(alertBox, 'The verification window has closed. Please sign in again.', 'error');
      return;
    }

    try {
      const result = await GoCart.getJson('/api/auth/mfa-status');

      if (result.status === 401) {
        clearInterval(pollTimer);
        window.location.href = '/login?reason=expired';
        return;
      }

      if (result.data.mfaCompleted) {
        clearInterval(pollTimer);
        statusLine.textContent = 'Verified. Redirecting to your dashboard...';
        window.location.href = result.data.redirect || '/dashboard';
      }
    } catch (error) {
      /* A single failed poll is not fatal - the next tick tries again. */
    }
  }

  // Send the first email as soon as the page opens, then start polling.
  sendVerificationEmail(false);
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);

  resendBtn.addEventListener('click', function () {
    sendVerificationEmail(true);
  });

  // Stop polling if the tab is closed or navigated away from.
  window.addEventListener('beforeunload', function () {
    if (pollTimer) clearInterval(pollTimer);
  });
})();
