/* MFA STEP 1 - password. On success the server moves us to the OTP page. */
(function () {
  'use strict';

  const form = document.getElementById('loginForm');
  const alertBox = document.getElementById('formAlert');
  const submitBtn = document.getElementById('submitBtn');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const toggleBtn = document.getElementById('togglePassword');

  // Show / hide password.
  toggleBtn.addEventListener('click', function () {
    const nowVisible = passwordInput.type === 'password';
    passwordInput.type = nowVisible ? 'text' : 'password';
    toggleBtn.setAttribute('aria-label', nowVisible ? 'Hide password' : 'Show password');
    passwordInput.focus();
  });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    GoCart.hideAlert(alertBox);

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      GoCart.showAlert(alertBox, 'Please enter both your email address and password.', 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying password...';

    try {
      const result = await GoCart.postJson('/api/auth/login', { email: email, password: password });

      if (result.data.success) {
        // The OTP is never kept in localStorage. In demo mode the server echoes
        // it once; we hand it to the next page through sessionStorage, which is
        // cleared when the tab closes.
        if (result.data.demoOtp) {
          try {
            sessionStorage.setItem('gocart_demo_otp', result.data.demoOtp);
          } catch (error) {
            /* storage disabled - the OTP is still in the console/outbox email */
          }
        }
        window.location.href = result.data.redirect || '/verify-otp';
        return;
      }

      GoCart.showAlert(alertBox, result.data.message || 'Invalid email or password.', 'error');
      passwordInput.value = '';
      passwordInput.focus();
    } catch (error) {
      GoCart.showAlert(alertBox, 'Could not reach the server. Please check your connection.', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Continue with Password';
    }
  });
})();
