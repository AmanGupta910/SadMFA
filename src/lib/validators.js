'use strict';

/**
 * Server-side validation.
 *
 * Client-side checks are only a convenience - anybody can bypass them with
 * curl or the browser console. Every rule here is therefore enforced again on
 * the server before a single row is written.
 */

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$/;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_NAME_LENGTH = 60;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 limit

function validateName(rawName) {
  const name = String(rawName || '').trim();
  if (name.length === 0) return { ok: false, message: 'Please enter your full name.' };
  if (name.length < 2) return { ok: false, message: 'Name must be at least 2 characters long.' };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  return { ok: true, value: name };
}

function validateEmail(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (email.length === 0) return { ok: false, message: 'Please enter your email address.' };
  if (email.length > MAX_EMAIL_LENGTH) return { ok: false, message: 'That email address is too long.' };
  if (!EMAIL_PATTERN.test(email)) return { ok: false, message: 'Please enter a valid email address.' };
  return { ok: true, value: email };
}

/**
 * Password strength policy, matching the hint shown on the registration form:
 * minimum 8 characters, 1 uppercase, 1 number, 1 symbol.
 */
function validatePassword(rawPassword) {
  const password = String(rawPassword || '');

  if (password.length === 0) return { ok: false, message: 'Please enter a password.' };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: 'Password must be 128 characters or fewer.' };
  }
  if (!/[A-Z]/.test(password)) return { ok: false, message: 'Password must contain at least one uppercase letter.' };
  if (!/[a-z]/.test(password)) return { ok: false, message: 'Password must contain at least one lowercase letter.' };
  if (!/[0-9]/.test(password)) return { ok: false, message: 'Password must contain at least one number.' };
  if (!/[^A-Za-z0-9]/.test(password)) return { ok: false, message: 'Password must contain at least one symbol (for example ! @ # $).' };

  return { ok: true, value: password };
}

function validatePasswordConfirmation(password, confirmPassword) {
  if (String(confirmPassword || '').length === 0) return { ok: false, message: 'Please confirm your password.' };
  if (password !== confirmPassword) return { ok: false, message: 'Passwords do not match. Please re-enter them.' };
  return { ok: true };
}

/** Runs the whole registration form through the rules above, first error wins. */
function validateRegistration({ name, email, password, confirmPassword }) {
  const nameCheck = validateName(name);
  if (!nameCheck.ok) return { ok: false, field: 'name', message: nameCheck.message };

  const emailCheck = validateEmail(email);
  if (!emailCheck.ok) return { ok: false, field: 'email', message: emailCheck.message };

  const passwordCheck = validatePassword(password);
  if (!passwordCheck.ok) return { ok: false, field: 'password', message: passwordCheck.message };

  const confirmCheck = validatePasswordConfirmation(passwordCheck.value, confirmPassword);
  if (!confirmCheck.ok) return { ok: false, field: 'confirmPassword', message: confirmCheck.message };

  return { ok: true, value: { name: nameCheck.value, email: emailCheck.value, password: passwordCheck.value } };
}

/** Hides the middle of an address: amangupta2726@gmail.com -> am**********26@gmail.com */
function maskEmail(email) {
  const text = String(email || '');
  const atIndex = text.indexOf('@');
  if (atIndex < 1) return text;

  const local = text.slice(0, atIndex);
  const domain = text.slice(atIndex);
  if (local.length <= 4) return `${local.slice(0, 1)}***${domain}`;

  return `${local.slice(0, 2)}${'*'.repeat(Math.max(3, local.length - 4))}${local.slice(-2)}${domain}`;
}

module.exports = {
  validateName,
  validateEmail,
  validatePassword,
  validatePasswordConfirmation,
  validateRegistration,
  maskEmail,
  MIN_PASSWORD_LENGTH,
};
