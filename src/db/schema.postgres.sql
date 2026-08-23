-- =============================================================================
-- GoCart MFA - Database Schema (PostgreSQL / Neon)
-- =============================================================================
-- The Postgres twin of schema.sql. The tables, columns and meanings are
-- identical; only the dialect differs:
--   INTEGER PRIMARY KEY AUTOINCREMENT  ->  GENERATED ALWAYS AS IDENTITY
--   (SQLite has no PRAGMA equivalent needed here)
--
-- Timestamps stay TEXT holding ISO-8601 UTC strings, exactly as in SQLite, so
-- the same comparison queries work unchanged on both engines.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- users : the permanent account record
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           TEXT    NOT NULL,
  email          TEXT    NOT NULL UNIQUE,   -- always stored lower-cased
  password_hash  TEXT    NOT NULL,          -- bcrypt hash, never a plain password
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- ---------------------------------------------------------------------------
-- mfa_sessions : one row per login attempt, tracks progress through the 3 steps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mfa_sessions (
  id                      TEXT    PRIMARY KEY,
  user_id                 INTEGER NOT NULL,

  password_verified       INTEGER NOT NULL DEFAULT 0,

  otp_hash                TEXT,
  otp_expires_at          TEXT,
  otp_attempts            INTEGER NOT NULL DEFAULT 0,
  otp_resend_count        INTEGER NOT NULL DEFAULT 0,
  otp_last_sent_at        TEXT,
  otp_verified            INTEGER NOT NULL DEFAULT 0,

  email_token_hash        TEXT,
  email_token_expires_at  TEXT,
  email_resend_count      INTEGER NOT NULL DEFAULT 0,
  email_last_sent_at      TEXT,
  email_verified          INTEGER NOT NULL DEFAULT 0,

  mfa_completed           INTEGER NOT NULL DEFAULT 0,
  status                  TEXT    NOT NULL DEFAULT 'pending',
  ip_address              TEXT,
  user_agent              TEXT,
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL,
  expires_at              TEXT    NOT NULL,

  CONSTRAINT fk_mfa_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mfa_sessions_user   ON mfa_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_mfa_sessions_token  ON mfa_sessions (email_token_hash);
CREATE INDEX IF NOT EXISTS idx_mfa_sessions_expiry ON mfa_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- auth_events : append-only audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_events (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        INTEGER,
  mfa_session_id TEXT,
  event          TEXT NOT NULL,
  detail         TEXT,
  ip_address     TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events (user_id);

-- ---------------------------------------------------------------------------
-- user_sessions : express-session storage (see src/db/sessionStore.js)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
  sid        TEXT   PRIMARY KEY,
  data       TEXT   NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions (expires_at);
