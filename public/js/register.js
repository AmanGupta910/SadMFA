/* Registration page. Client-side checks are a convenience only - the server
   validates every field again in /api/auth/register. */
(function () {
  'use strict';

  const form = document.getElementById('registerForm');
  const alertBox = document.getElementById('formAlert');
  const submitBtn = document.getElementById('submitBtn');

  const fields = {
    name: document.getElementById('name'),
    email: document.getElementById('email'),
    password: document.getElementById('password'),
    confirmPassword: document.getElementById('confirmPassword'),
  };

  function clearInvalid() {
    Object.keys(fields).forEach(function (key) {
      fields[key].removeAttribute('aria-invalid');
    });
  }

  function markInvalid(fieldName) {
    if (fieldName && fields[fieldName]) {
      fields[fieldName].setAttribute('aria-invalid', 'true');
      fields[fieldName].focus();
    }
  }

  /** Mirrors the server policy so the user gets instant feedback. */
  function quickCheck(values) {
    if (!values.name) return { field: 'name', message: 'Please enter your full name.' };
    if (!values.email) return { field: 'email', message: 'Please enter your email address.' };
    if (values.password.length < 8) {
      return { field: 'password', message: 'Password must be at least 8 characters long.' };
    }
    if (!/[A-Z]/.test(values.password)) {
      return { field: 'password', message: 'Password must contain at least one uppercase letter.' };
    }
    if (!/[0-9]/.test(values.password)) {
      return { field: 'password', message: 'Password must contain at least one number.' };
    }
    if (!/[^A-Za-z0-9]/.test(values.password)) {
      return { field: 'password', message: 'Password must contain at least one symbol (for example ! @ # $).' };
    }
    if (values.password !== values.confirmPassword) {
      return { field: 'confirmPassword', message: 'Passwords do not match. Please re-enter them.' };
    }
    return null;
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    GoCart.hideAlert(alertBox);
    clearInvalid();

    const values = {
      name: fields.name.value.trim(),
      email: fields.email.value.trim(),
      password: fields.password.value,
      confirmPassword: fields.confirmPassword.value,
    };

    const problem = quickCheck(values);
    if (problem) {
      GoCart.showAlert(alertBox, problem.message, 'error');
      markInvalid(problem.field);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account...';

    try {
      const result = await GoCart.postJson('/api/auth/register', values);

      if (result.data.success) {
        window.location.href = result.data.redirect || '/login?registered=1';
        return;
      }

      GoCart.showAlert(alertBox, result.data.message || 'Registration failed. Please try again.', 'error');
      markInvalid(result.data.field);
    } catch (error) {
      GoCart.showAlert(alertBox, 'Could not reach the server. Please check your connection.', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Register & Begin MFA Setup';
    }
  });
})();
