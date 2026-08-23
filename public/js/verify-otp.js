/* MFA STEP 2 - one-time password.
   Six single-character boxes that behave like one field: typing advances,
   backspace goes back, and pasting a full code fills them all. */
(function () {
  'use strict';

  const card = document.querySelector('.card');
  const form = document.getElementById('otpForm');
  const wrapper = document.getElementById('otpInputs');
  const boxes = Array.prototype.slice.call(wrapper.querySelectorAll('input'));
  const alertBox = document.getElementById('formAlert');
  const verifyBtn = document.getElementById('verifyBtn');
  const resendBtn = document.getElementById('resendBtn');
  const countdownEl = document.getElementById('countdown');

  const otpLength = Number(card.dataset.otpLength) || 6;
  const resendCooldown = Number(card.dataset.resendCooldown) || 30;

  let stopCountdown = function () {};
  let expired = false;

  // ---------------------------------------------------------------- demo --
  try {
    const stored = sessionStorage.getItem('gocart_demo_otp');
    if (stored) GoCart.showDemoOtp(stored);
  } catch (error) {
    /* sessionStorage unavailable - ignore */
  }

  // ----------------------------------------------------------- countdown --
  function runCountdown(seconds) {
    stopCountdown();
    expired = false;
    countdownEl.classList.remove('is-expired');
    verifyBtn.disabled = false;

    stopCountdown = GoCart.startCountdown(
      seconds,
      function (remaining) {
        countdownEl.textContent = GoCart.formatClock(remaining) + ' remaining';
      },
      function () {
        expired = true;
        countdownEl.textContent = 'Code expired - please request a new one.';
        countdownEl.classList.add('is-expired');
        verifyBtn.disabled = true;
      }
    );
  }

  runCountdown(Number(card.dataset.secondsLeft) || 0);

  // ------------------------------------------------------------ the boxes --
  function currentCode() {
    return boxes
      .map(function (box) {
        return box.value.trim();
      })
      .join('');
  }

  function clearBoxes(focusFirst) {
    boxes.forEach(function (box) {
      box.value = '';
    });
    if (focusFirst) boxes[0].focus();
  }

  /** Writes one digit per box starting at `startIndex`, then parks the cursor. */
  function spread(startIndex, digits) {
    let cursor = startIndex;
    for (let i = 0; i < digits.length && cursor < boxes.length; i += 1, cursor += 1) {
      boxes[cursor].value = digits.charAt(i);
    }
    boxes[Math.min(cursor, boxes.length - 1)].focus();
  }

  boxes.forEach(function (box, index) {
    box.addEventListener('input', function () {
      wrapper.classList.remove('is-error');

      const digits = box.value.replace(/[^0-9]/g, '');

      if (digits.length === 0) {
        box.value = '';
        return;
      }

      // More than one digit arrives when the user types quickly, pastes, or a
      // phone autofills the SMS code into the first box. Spread it out rather
      // than dropping everything after the first character.
      if (digits.length > 1) {
        spread(index, digits);
        return;
      }

      box.value = digits;
      if (index < boxes.length - 1) boxes[index + 1].focus();
    });

    box.addEventListener('keydown', function (event) {
      if (event.key === 'Backspace' && !box.value && index > 0) {
        boxes[index - 1].focus();
        boxes[index - 1].value = '';
        event.preventDefault();
      }
      if (event.key === 'ArrowLeft' && index > 0) boxes[index - 1].focus();
      if (event.key === 'ArrowRight' && index < boxes.length - 1) boxes[index + 1].focus();
    });

    box.addEventListener('paste', function (event) {
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData).getData('text') || '';
      const digits = text.replace(/[^0-9]/g, '').slice(0, otpLength);
      if (!digits) return;

      // A pasted full code always fills from the first box.
      spread(0, digits);
    });
  });

  // ---------------------------------------------------------------- submit --
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    GoCart.hideAlert(alertBox);
    wrapper.classList.remove('is-error');

    const code = currentCode();

    if (code.length !== otpLength) {
      GoCart.showAlert(alertBox, 'Please enter all ' + otpLength + ' digits of the code.', 'error');
      wrapper.classList.add('is-error');
      return;
    }

    if (expired) {
      GoCart.showAlert(alertBox, 'This OTP has expired. Please request a new code.', 'error');
      return;
    }

    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying...';

    try {
      const result = await GoCart.postJson('/api/auth/verify-otp', { otp: code });

      if (result.data.success) {
        try {
          sessionStorage.removeItem('gocart_demo_otp');
        } catch (error) {
          /* ignore */
        }
        window.location.href = result.data.redirect || '/verify-email';
        return;
      }

      // Locked out or session gone: the server tells us where to go.
      if (result.data.redirect) {
        window.location.href = result.data.redirect;
        return;
      }

      let message = result.data.message || 'Invalid or Expired OTP. Please try again.';
      if (typeof result.data.attemptsRemaining === 'number' && result.data.maxAttempts) {
        message += ' (Attempts remaining: ' + result.data.attemptsRemaining + '/' + result.data.maxAttempts + ')';
      }

      GoCart.showAlert(alertBox, message, 'error');
      wrapper.classList.add('is-error');
      clearBoxes(true);
    } catch (error) {
      GoCart.showAlert(alertBox, 'Could not reach the server. Please check your connection.', 'error');
    } finally {
      verifyBtn.textContent = 'Verify OTP';
      verifyBtn.disabled = expired;
    }
  });

  // ---------------------------------------------------------------- resend --
  function lockResend(seconds) {
    resendBtn.disabled = true;
    GoCart.startCountdown(
      seconds,
      function (remaining) {
        resendBtn.textContent = 'Resend Code (' + remaining + 's)';
      },
      function () {
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend Code';
      }
    );
  }

  resendBtn.addEventListener('click', async function () {
    GoCart.hideAlert(alertBox);
    resendBtn.disabled = true;
    resendBtn.textContent = 'Sending...';

    try {
      const result = await GoCart.postJson('/api/auth/resend-otp', {});

      if (result.data.success) {
        GoCart.showAlert(alertBox, result.data.message || 'A new code has been sent.', 'success');
        clearBoxes(true);
        wrapper.classList.remove('is-error');
        runCountdown(result.data.expiresInSeconds || 300);

        if (result.data.demoOtp) {
          GoCart.showDemoOtp(result.data.demoOtp);
          try {
            sessionStorage.setItem('gocart_demo_otp', result.data.demoOtp);
          } catch (error) {
            /* ignore */
          }
        }

        lockResend(resendCooldown);
        return;
      }

      if (result.data.redirect) {
        window.location.href = result.data.redirect;
        return;
      }

      GoCart.showAlert(alertBox, result.data.message || 'Could not resend the code.', 'error');
      lockResend(result.data.retryAfterSeconds || resendCooldown);
    } catch (error) {
      GoCart.showAlert(alertBox, 'Could not reach the server. Please check your connection.', 'error');
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend Code';
    }
  });
})();
