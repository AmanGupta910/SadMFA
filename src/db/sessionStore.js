'use strict';

/**
 * SQLite-backed session store for express-session.
 *
 * The default MemoryStore is fine on a laptop but unusable once deployed:
 *   - every session is lost when the server restarts, so a redeploy would throw
 *     users out in the middle of the MFA ceremony,
 *   - it grows without bound (it never truly frees expired sessions), and
 *   - express-session prints a production warning telling you not to use it.
 *
 * This keeps sessions in the same SQLite file as everything else, so the project
 * still needs no extra dependency and no separate session server (Redis).
 */

const { Store } = require('express-session');

class SqliteSessionStore extends Store {
  /**
   * @param {import('node:sqlite').DatabaseSync} db open database handle
   * @param {{ ttlMs?: number, pruneIntervalMs?: number }} options
   */
  constructor(db, options = {}) {
    super();

    this.db = db;
    this.ttlMs = options.ttlMs || 24 * 60 * 60 * 1000;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        sid        TEXT    PRIMARY KEY,
        data       TEXT    NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions (expires_at);
    `);

    this.statements = {
      get: this.db.prepare('SELECT data, expires_at FROM user_sessions WHERE sid = ?'),
      upsert: this.db.prepare(
        `INSERT INTO user_sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
      ),
      touch: this.db.prepare('UPDATE user_sessions SET expires_at = ? WHERE sid = ?'),
      destroy: this.db.prepare('DELETE FROM user_sessions WHERE sid = ?'),
      prune: this.db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?'),
      count: this.db.prepare('SELECT COUNT(*) AS total FROM user_sessions WHERE expires_at > ?'),
      all: this.db.prepare('SELECT sid, data FROM user_sessions WHERE expires_at > ?'),
      clear: this.db.prepare('DELETE FROM user_sessions'),
    };

    this.prune();

    // Housekeeping, so expired rows cannot accumulate forever.
    const interval = options.pruneIntervalMs || 15 * 60 * 1000;
    this.pruneTimer = setInterval(() => this.prune(), interval);
    this.pruneTimer.unref();
  }

  /** Absolute expiry for a session, in epoch milliseconds. */
  expiryOf(session) {
    const cookie = session && session.cookie;

    if (cookie && cookie.expires) {
      const time = new Date(cookie.expires).getTime();
      if (Number.isFinite(time)) return time;
    }
    if (cookie && Number.isFinite(cookie.maxAge)) {
      return Date.now() + cookie.maxAge;
    }
    return Date.now() + this.ttlMs;
  }

  get(sid, callback) {
    try {
      const row = this.statements.get.get(sid);
      if (!row) return callback(null, null);

      // Treat an expired row as absent, and clean it up on the way past.
      if (row.expires_at <= Date.now()) {
        this.statements.destroy.run(sid);
        return callback(null, null);
      }

      return callback(null, JSON.parse(row.data));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, session, callback) {
    try {
      this.statements.upsert.run(sid, JSON.stringify(session), this.expiryOf(session));
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  /** Called on every request when `rolling` is on, to extend the expiry. */
  touch(sid, session, callback) {
    try {
      this.statements.touch.run(this.expiryOf(session), sid);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  destroy(sid, callback) {
    try {
      this.statements.destroy.run(sid);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  length(callback) {
    try {
      return callback(null, this.statements.count.get(Date.now()).total);
    } catch (error) {
      return callback(error);
    }
  }

  all(callback) {
    try {
      const rows = this.statements.all.all(Date.now());
      return callback(null, rows.map((row) => JSON.parse(row.data)));
    } catch (error) {
      return callback(error);
    }
  }

  clear(callback) {
    try {
      this.statements.clear.run();
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  prune() {
    try {
      return this.statements.prune.run(Date.now()).changes;
    } catch (error) {
      console.error('  Session prune failed:', error.message);
      return 0;
    }
  }
}

module.exports = { SqliteSessionStore };
