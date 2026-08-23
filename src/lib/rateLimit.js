'use strict';

/**
 * Very small in-memory rate limiter (fixed window per key).
 *
 * Good enough for a single-process college project. A production deployment
 * behind several servers would keep these counters in Redis instead, because
 * an in-memory map is not shared between processes and is lost on restart.
 */

const buckets = new Map();

/**
 * Records one attempt for `key` and reports whether the caller is over budget.
 * @returns {{ allowed: boolean, remaining: number, retryAfterSeconds: number }}
 */
function hit(key, { max, windowMs }) {
  const nowMs = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || nowMs >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
    return { allowed: true, remaining: max - 1, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }

  bucket.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000));

  return {
    allowed: bucket.count <= max,
    remaining: Math.max(0, max - bucket.count),
    retryAfterSeconds,
  };
}

/** Clears the counter, e.g. after a successful login. */
function reset(key) {
  buckets.delete(key);
}

/** Periodic cleanup so the map cannot grow without bound. */
function sweep() {
  const nowMs = Date.now();
  for (const [key, bucket] of buckets) {
    if (nowMs >= bucket.resetAt) buckets.delete(key);
  }
}

module.exports = { hit, reset, sweep };
