# GoCart — Multi-Factor Authentication (MFA)

**Implementation of Multi-Factor Authentication using a minimum of three authentication steps.**

A user must pass **all three** factors before the Store Dashboard is unlocked:

| Step | Factor | Type | Proves |
|---|---|---|---|
| 1 | Email + Password | Knowledge — *something you know* | You know the account secret |
| 2 | 6-digit OTP sent by email | Possession — *something you have* | You can open the registered inbox |
| 3 | “YES, IT’S ME” approval link | Ownership confirmation | The real owner approves this login |

The final logged-in session is created **only** after step 3. Knowing the password alone gets you nowhere.

---

## 1. Set-up (do this once)

### Step A — install

```bash
npm install
```

### Step B — connect your email account **(required)**

The OTP and the approval link are delivered by real email, so the app needs an
account to send from. This command asks for the details in your own terminal and
writes them into `.env`. The password is typed hidden and is never displayed.

```bash
npm run setup-email
```

For Gmail you need an **App Password**, not your normal password:

1. Turn on 2-Step Verification → <https://myaccount.google.com/security>
2. Create an App Password → <https://myaccount.google.com/apppasswords>
   (choose *Mail* → *Windows Computer*)
3. Google shows a 16-character code like `abcd efgh ijkl mnop` — paste that into the prompt.

> Your normal Gmail password will **not** work. Google blocks it for SMTP.

### Step C — prove email delivery works

```bash
npm run test-email
```

A sample message should land in your inbox (check Spam the first time). Do this
**before** the demo — it catches a wrong password in 5 seconds instead of in front
of your teacher.

### Step D — run it

```bash
npm start
```

Open <http://localhost:3000>

---

## 2. The demo, step by step

| # | Action | What the evaluator sees |
|---|---|---|
| 1 | Open `/register` | GoCart Registration Page — *Step 1 of 3* |
| 2 | Fill in name, **a real email you can open**, password | Live password-strength rules |
| 3 | Submit | Redirected to `/login` |
| 4 | Enter email + **wrong** password | “Invalid email or password.” — rejected |
| 5 | Enter email + correct password | **Factor 1 passed** → `/verify-otp` |
| 6 | Open your inbox | 6-digit code has arrived |
| 7 | Type a **wrong** OTP | Red boxes, “Attempts remaining: 4/5” |
| 8 | Type the real OTP | **Factor 2 passed** → `/verify-email` |
| 9 | Show the waiting screen | “Email Verification Pending” + live countdown |
| 10 | Open the second email, click **“YES, IT’S ME”** | “Email Verified Successfully” |
| 11 | Watch the first tab | It notices automatically and moves on |
| 12 | Dashboard appears | **MFA COMPLETED SUCCESSFULLY** — all three ✓ |
| 13 | Click Logout, then type `/dashboard` in the address bar | Bounced back to login |

**Strongest thing to show:** at step 5, before entering the OTP, type
`localhost:3000/dashboard` into the address bar. You are sent back to the login
page — the correct password on its own is not enough.

---

## 3. MFA flow

```
                    ┌──────────────┐
                    │  REGISTER    │  name, email, password
                    └──────┬───────┘  password hashed with bcrypt
                           ↓
                    ┌──────────────┐
                    │   LOGIN      │  STEP 1: password
                    └──────┬───────┘
                  invalid ↙        ↘ valid
              ┌────────────┐   ┌──────────────────────┐
              │  REJECTED  │   │ create MFA session   │
              └────────────┘   │ generate 6-digit OTP │
                               │ email it to the user │
                               └──────────┬───────────┘
                                          ↓
                               ┌──────────────────────┐
                               │  /verify-otp         │  STEP 2: possession
                               └──────────┬───────────┘
                   wrong / expired ↙        ↘ correct
              ┌──────────────────────┐   ┌──────────────────────┐
              │ retry — attempts −1  │   │ burn OTP             │
              │ 5 strikes = locked   │   │ issue email token    │
              └──────────────────────┘   └──────────┬───────────┘
                                                    ↓
                                         ┌──────────────────────┐
                                         │  /verify-email       │  STEP 3
                                         │  "YES, IT'S ME"      │
                                         └──────────┬───────────┘
                              invalid / expired ↙      ↘ valid
                         ┌──────────────────────┐   ┌──────────────────────┐
                         │       REJECTED       │   │ burn token           │
                         └──────────────────────┘   │ mfa_completed = 1    │
                                                    │ CREATE LOGIN SESSION │
                                                    └──────────┬───────────┘
                                                               ↓
                                                    ┌──────────────────────┐
                                                    │     /dashboard       │
                                                    └──────────────────────┘
```

---

## 4. Folder structure

```
SAD/
├── server.js                    Express app, security headers, session, boot
├── package.json
├── .env                         real settings (git-ignored, never commit)
├── .env.example                 safe template with dummy values
│
├── src/
│   ├── config/env.js            loads + validates every setting
│   ├── db/
│   │   ├── index.js             SQLite connection (node:sqlite, no install)
│   │   ├── schema.sql           table definitions
│   │   └── init.js              npm run init-db / reset-db
│   ├── models/
│   │   ├── userRepo.js          users table access
│   │   ├── mfaSessionRepo.js    per-login MFA state
│   │   └── auditRepo.js         authentication event log
│   ├── lib/
│   │   ├── password.js          bcrypt hash + verify
│   │   ├── otp.js               secure 6-digit OTP generate/hash/verify
│   │   ├── tokens.js            256-bit email token + SHA-256 hashing
│   │   ├── validators.js        server-side field validation
│   │   ├── emailDeliverability.js  blocks fake / undeliverable addresses
│   │   ├── mailer.js            nodemailer SMTP + error explanations
│   │   ├── emailTemplates.js    OTP email + "YES, IT'S ME" email
│   │   └── rateLimit.js         brute-force throttling
│   ├── middleware/guards.js     the rules that block step-skipping
│   └── routes/
│       ├── auth.js              /api/auth/*
│       └── pages.js             page rendering
│
├── views/                       EJS templates (register, login, verify-otp,
│                                verify-email, dashboard, store, errors)
├── public/css/styles.css        GoCart blue/grey theme, responsive
├── public/js/                   one small script per page
├── scripts/
│   ├── setup-email.js           npm run setup-email  (hidden password entry)
│   ├── test-email.js            npm run test-email
│   └── start-offline.js         npm run start:offline (no-internet fallback)
├── tests/mfa-flow.test.js       59 automated checks
└── data/                        SQLite database (created on first run)
```

---

## 5. Database schema

### `users` — the permanent account

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | Account id |
| `name` | TEXT | Full name |
| `email` | TEXT UNIQUE | Lower-cased; uniqueness blocks duplicate signup |
| `password_hash` | TEXT | **bcrypt hash** — the plain password is never stored |
| `email_verified` | INTEGER | 1 once the address has proved reachable |
| `created_at` / `updated_at` | TEXT | ISO-8601 timestamps |

### `mfa_sessions` — one row per login attempt

| Column | Purpose |
|---|---|
| `id` | 256-bit random session id (unguessable) |
| `user_id` | Owning account |
| `password_verified` | STEP 1 cleared |
| `otp_hash` | **bcrypt hash of the OTP** — never the digits themselves |
| `otp_expires_at` | 5-minute deadline |
| `otp_attempts` | Failed tries; 5 locks the attempt |
| `otp_resend_count`, `otp_last_sent_at` | Resend limit + 30 s cooldown |
| `otp_verified` | STEP 2 cleared |
| `email_token_hash` | **SHA-256 hash** of the emailed token |
| `email_token_expires_at` | 15-minute deadline |
| `email_resend_count`, `email_last_sent_at` | Resend limit + cooldown |
| `email_verified` | STEP 3 cleared |
| `mfa_completed` | All three done — the gate for the dashboard |
| `status` | `pending` / `completed` / `locked` / `superseded` |
| `ip_address`, `user_agent` | Shown in the approval email |
| `expires_at` | Whole ceremony must finish within 20 minutes |

> **Why a separate table?** Putting `otp_hash` on the user row would allow only
> one login attempt at a time and would leave stale secrets behind after login.
> A short-lived session row is deleted independently and is the standard way to
> model a multi-step authentication ceremony.

### `auth_events` — audit trail

Append-only log (`USER_REGISTERED`, `LOGIN_PASSWORD_FAILED`, `OTP_VERIFIED`,
`MFA_COMPLETED`, …). The dashboard shows the most recent entries.

---

## 6. API routes

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Validate, check duplicates, hash password, create account |
| POST | `/api/auth/login` | **STEP 1** — verify password, open MFA session, email the OTP |
| POST | `/api/auth/verify-otp` | **STEP 2** — verify the code, enforce attempt limit |
| POST | `/api/auth/resend-otp` | New OTP; invalidates the old one |
| POST | `/api/auth/send-email-verification` | **STEP 3** — issue + email the approval token |
| GET | `/api/auth/verify-email?token=…` | The “YES, IT’S ME” link; completes MFA |
| GET | `/api/auth/mfa-status` | Lets the waiting tab notice the link was clicked |
| POST | `/api/auth/logout` | Destroy the session |

Pages: `/register`, `/login`, `/verify-otp`, `/verify-email`, `/dashboard`, `/store`.

---

## 7. Security measures

**Passwords**
- bcrypt, cost factor 12, unique salt per user — plain text never stored or returned.
- Policy enforced on the server: 8+ chars, uppercase, lowercase, number, symbol.
- Wrong password and unknown account return the *same* message and take a similar
  amount of time, so the API cannot be used to discover which emails are registered.

**OTP**
- Generated with `crypto.randomInt` (OS cryptographic randomness, no modulo bias).
  `Math.random()` is predictable and is never used.
- Stored as a **bcrypt hash + server-side pepper**, because 6 digits is only ~20 bits
  of entropy and a fast hash could be brute-forced from a stolen database.
- 5-minute expiry · single use (hash cleared on success) · 5-attempt limit ·
  30-second resend cooldown · max 3 resends · a new code invalidates the old one.

**Email approval token**
- 32 random bytes (256 bits) from `crypto.randomBytes`.
- Only **SHA-256(token + pepper)** is stored; the raw token exists only in the email.
- 15-minute expiry, single use, cleared after use, tied to one MFA session, and
  rejected unless steps 1 and 2 already passed.

**Email address quality**
- Rejects documentation domains (`example.com`), disposable inboxes, common typos
  (`gmial.com`), and any domain with no MX record — so an account can never be
  created at an address that cannot receive the OTP.

**Session**
- The login session is created in exactly one place: after step 3 succeeds.
- Cookie is `httpOnly` (invisible to JavaScript), `sameSite=lax`, `secure` in
  production, and the session id is regenerated on login (anti session-fixation).
- Auth pages send `no-store`, so the back button cannot resurrect them.

**Application**
- Security headers: CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`.
- All SQL uses bound parameters; user HTML is escaped in emails.
- Rate limiting on login and registration.
- Errors are logged on the server; the browser only ever sees a short generic
  message — no stack traces, SQL, or file paths.
- No secret is hard-coded: everything comes from `.env`, which is git-ignored.

---

## 8. Testing

Automated suite — **59 checks**, covering the whole assignment checklist:

```bash
npm run start:offline
```

then, in a second terminal:

```bash
npm test
```

`start:offline` is a test-only mode: it writes emails to `data/outbox/` instead of
sending them and exposes the OTP so a script can read it. The real `npm start`
never does either.

Covered: registration, duplicate rejection, password hashing, weak-password and
mismatch rejection, wrong password, user-enumeration resistance, OTP generation
/wrong/expired/correct/reuse, resend + cooldown + attempt lockout, token
invalid/expired/reused, dashboard blocked after 1 and after 2 factors, dashboard
allowed after 3, logout, email-validity rules, and security headers.

---

## 9. Common problems

| Symptom | Cause | Fix |
|---|---|---|
| Server won't start: “EMAIL_* still contains the example values” | Email not configured yet | `npm run setup-email` |
| “Username and Password not accepted” | Using the normal Gmail password | Create an **App Password**; 2-Step Verification must be ON |
| No email arrives | Wrong address, or it's in Spam | Check Spam; run `npm run test-email` |
| `ETIMEDOUT` / `ECONNREFUSED` | College network blocks port 587 | Try a mobile hotspot, or use `npm run start:offline` |
| “Please use a real email address” | `example.com` / disposable / typo | Use an inbox you can actually open |
| “We could not verify that email domain” | No internet for the MX lookup | Reconnect, or set `VERIFY_EMAIL_MX=false` in `.env` |
| Sent back to login during the flow | MFA session expired (20 min) | Start the login again |
| “Too many incorrect attempts” | 5 wrong OTPs | Log in again for a fresh code |
| Port 3000 already in use | Old server still running | Close it, or set `PORT=3001` in `.env` |
| Old CSS/JS after an edit | Browser cache | Already handled by versioned asset URLs; hard-refresh with `Ctrl+F5` |

Reset all accounts and start clean:

```bash
npm run reset-db
```

---

## 10. Command reference

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run setup-email` | Configure SMTP (hidden password entry) |
| `npm run check-email` | Test the login only — sends nothing, fast to retry |
| `npm run test-email` | Send one test message to prove delivery |
| `npm start` | Run the app with real email — **use this for the demo** |
| `npm run dev` | Same, auto-restart on file change |
| `npm run start:offline` | No-internet / test mode (OTP shown on screen) |
| `npm test` | Run the 59 automated checks |
| `npm run init-db` | Create tables |
| `npm run reset-db` | Drop everything and recreate |

**Requirements:** Node.js 22.5 or newer (uses the built-in `node:sqlite`), and an
email account for sending. No database server and no compiler needed.
