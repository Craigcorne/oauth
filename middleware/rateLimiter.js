// utils/rateLimiter.js

const ErrorHandler = require("../utils/ErrorHandler");

class MemoryStore {
  constructor() {
    this.windows = new Map(); // key => { count, resetAt }
    // Periodic cleanup every 10 minutes to prevent unbounded growth
    this.gcInterval = setInterval(() => this._gc(), 10 * 60 * 1000);
  }

  _gc() {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      if (entry.resetAt <= now) this.windows.delete(key);
    }
  }

  async hit(key, windowMs, maxAttempts) {
    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || entry.resetAt <= now) {
      // New window
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return {
        allowed: true,
        remaining: maxAttempts - 1,
        resetAt: now + windowMs,
      };
    }

    if (entry.count >= maxAttempts) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.resetAt,
        retryAfter: Math.ceil((entry.resetAt - now) / 1000),
      };
    }

    entry.count += 1;
    return {
      allowed: true,
      remaining: maxAttempts - entry.count,
      resetAt: entry.resetAt,
    };
  }
}

// Singleton store instance
const store = new MemoryStore();

/**
 * Returns middleware that limits requests by a custom key function.
 */
function createRateLimiter({ windowMs, maxAttempts, keyGenerator, message }) {
  return async (req, res, next) => {
    const key = keyGenerator(req);
    const result = await store.hit(key, windowMs, maxAttempts);

    // Always set headers so the client knows the limit
    res.setHeader("X-RateLimit-Limit", maxAttempts);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, result.remaining));
    res.setHeader("X-RateLimit-Reset", new Date(result.resetAt).toISOString());

    if (!result.allowed) {
      res.setHeader("Retry-After", result.retryAfter);
      return next(
        new ErrorHandler(
          message || `Too many attempts. Try again in ${result.retryAfter}s.`,
          429,
        ),
      );
    }

    next();
  };
}

module.exports = { createRateLimiter, MemoryStore };
