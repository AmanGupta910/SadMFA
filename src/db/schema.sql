-- =============================================================================
-- GoCart MFA - Database Schema (SQLite)
-- =============================================================================
-- Design note:
--   The account record (users) is kept separate from the per-login-attempt MFA
--   state (mfa_sessions). Storing otp_hash / email_token_hash on the users row
--   would mean one user could only ever have one login attempt in flight, and
--   the columns would stay behind as stale secrets after a successful login.
--   A short-lived session row is deleted/expired independently and is the
--   textbook way to model a multi-step authentication ceremony.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- users : the permanent account record
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,   -- always stored lower-cased
  password_hash TEXT    NOT NULL,          -- bcrypt hash, never a plain password
  email_verified INTEGER NOT NULL DEFAULT 0, -- 1 once the address proved reachable
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- ---------------------------------------------------------------------------
-- mfa_sessions : one row per login attempt, tracks progress through the 3 steps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mfa_sessions (
  id                      TEXT    PRIMARY KEY,   -- 256-bit random id (mfaSessionId)
  user_id                 INTEGER NOT NULL,

  -- STEP 1 : password
  password_verified       INTEGER NOT NULL DEFAULT 0,

  -- STEP 2 : one-time password
  otp_hash                TEXT,                  -- bcrypt hash of the 6-digit OTP
  otp_expires_at          TEXT,
  otp_attempts            INTEGER NOT NULL DEFAULT 0,
  otp_resend_count        INTEGER NOT NULL DEFAULT 0,
  otp_last_sent_at        TEXT,
  otp_verified            INTEGER NOT NULL DEFAULT 0,

  -- STEP 3 : email approval link
  email_token_hash        TEXT,                  -- SHA-256 hash of the 256-bit token
  email_token_expires_at  TEXT,
  email_resend_count      INTEGER NOT NULL DEFAULT 0,
  email_last_sent_at      TEXT,
  email_verified          INTEGER NOT NULL DEFAULT 0,

  -- overall
  mfa_completed           INTEGER NOT NULL DEFAULT 0,
  status                  TEXT    NOT NULL DEFAULT 'pending', -- pending|completed|locked
  ip_address              TEXT,
  user_agent              TEXT,
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL,
  expires_at              TEXT    NOT NULL,      -- whole ceremony must finish by then

  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mfa_sessions_user   ON mfa_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_sessions_token  ON mfa_sessions (email_token_hash);
CREATE INDEX IF NOT EXISTS idx_mfa_sessions_expiry ON mfa_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- auth_events : append-only audit trail (useful evidence for the report)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER,
  mfa_session_id TEXT,
  event          TEXT NOT NULL,   -- e.g. LOGIN_PASSWORD_OK, OTP_FAILED, MFA_COMPLETED
  detail         TEXT,
  ip_address     TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events (user_id);
