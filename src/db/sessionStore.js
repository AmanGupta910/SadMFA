'use strict';

/**
 * Database-backed session store for express-session.
 *
 * The default MemoryStore is unusable once deployed:
 *   - every session is lost when the server restarts, so a redeploy would throw
 *     users out in the middle of the MFA ceremony,
 *   - on a serverless platform each request can hit a different instance, so an
 *     in-memory session would simply not be found, and
 *   - express-session prints a production warning telling you not to use it.
 *
 * Sessions are kept in the same database as everything else, so this works
 * identically on local SQLite and on Neon Postgres.
 */

const { Store } = require('express-session');
const db = require('./index');

class DatabaseSessionStore extends Store {
  /** @param {{ ttlMs?: number, pruneIntervalMs?: number }} options */
  constructor(options = {}) {
    super();

    this.ttlMs = options.ttlMs || 24 * 60 * 60 * 1000;

    // Best-effort background cleanup so expired rows cannot accumulate.
    // Serverless instances are short-lived, so this simply may not fire there -
    // `get` also drops any expired row it happens to read.
    const interval = options.pruneIntervalMs || 15 * 60 * 1000;
    this.pruneTimer = setInterval(() => {
      this.prune().catch(() => {});
    }, interval);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
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
    db.get('SELECT data, expires_at FROM user_sessions WHERE sid = ?', [sid])
      .then(async (row) => {
        if (!row) return callback(null, null);

        // Treat an expired row as absent, and clean it up on the way past.
        if (Number(row.expires_at) <= Date.now()) {
          await db.run('DELETE FROM user_sessions WHERE sid = ?', [sid]);
          return callback(null, null);
        }

        return callback(null, JSON.parse(row.data));
      })
      .catch(callback);
  }

  set(sid, session, callback) {
    db.run(
      `INSERT INTO user_sessions (sid, data, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
      [sid, JSON.stringify(session), this.expiryOf(session)]
    )
      .then(() => callback(null))
      .catch(callback);
  }

  /** Called on every request when `rolling` is on, to extend the expiry. */
  touch(sid, session, callback) {
    db.run('UPDATE user_sessions SET expires_at = ? WHERE sid = ?', [this.expiryOf(session), sid])
      .then(() => callback(null))
      .catch(callback);
  }

  destroy(sid, callback) {
    db.run('DELETE FROM user_sessions WHERE sid = ?', [sid])
      .then(() => callback(null))
      .catch(callback);
  }

  length(callback) {
    db.get('SELECT COUNT(*) AS total FROM user_sessions WHERE expires_at > ?', [Date.now()])
      .then((row) => callback(null, Number(row ? row.total : 0)))
      .catch(callback);
  }

  all(callback) {
    db.all('SELECT sid, data FROM user_sessions WHERE expires_at > ?', [Date.now()])
      .then((rows) => callback(null, rows.map((row) => JSON.parse(row.data))))
      .catch(callback);
  }

  clear(callback) {
    db.run('DELETE FROM user_sessions')
      .then(() => callback(null))
      .catch(callback);
  }

  async prune() {
    const result = await db.run('DELETE FROM user_sessions WHERE expires_at <= ? RETURNING sid', [Date.now()]);
    return result.changes;
  }
}

module.exports = { DatabaseSessionStore };
