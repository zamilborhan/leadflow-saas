/**
 * Sliding-window rate limiter (in-memory).
 *
 * Appropriate for auth abuse protection on a single instance. Each key keeps
 * the timestamps of recent attempts inside the window; a request is allowed
 * when fewer than `limit` attempts are recorded.
 *
 * Production note: state is per-process. When running multiple instances,
 * replace the backing store with Redis (same interface, `REDIS_URL` is
 * already configured) without changing call sites.
 */

export type Clock = () => number;

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the oldest attempt leaves the window (0 when allowed). */
  retryAfterMs: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly clock: Clock;

  constructor(clock: Clock = () => Date.now()) {
    this.clock = clock;
  }

  check(key: string, limit: number, windowMs: number): RateLimitDecision {
    const now = this.clock();
    const cutoff = now - windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= limit) {
      return { allowed: false, retryAfterMs: recent[0] + windowMs - now };
    }
    recent.push(now);
    // Bound memory: drop the key entirely once it goes quiet.
    if (recent.length === 0) {
      this.hits.delete(key);
    } else {
      this.hits.set(key, recent);
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** For tests/clocks: drop all state. */
  clear(): void {
    this.hits.clear();
  }
}

/** Process-wide limiter used by auth Route Handlers. */
export const authRateLimiter = new RateLimiter();

/** Per-endpoint budgets: [max attempts, window]. */
export const RATE_LIMITS = {
  register: { limit: 10, windowMs: 10 * 60 * 1000 },
  registerEmail: { limit: 3, windowMs: 60 * 60 * 1000 },
  registerGlobal: { limit: 500, windowMs: 10 * 60 * 1000 },
  loginIp: { limit: 20, windowMs: 10 * 60 * 1000 },
  loginEmail: { limit: 10, windowMs: 15 * 60 * 1000 },
  forgotPassword: { limit: 5, windowMs: 60 * 60 * 1000 },
  forgotEmail: { limit: 3, windowMs: 60 * 60 * 1000 },
  resetPassword: { limit: 10, windowMs: 10 * 60 * 1000 },
  verifyConfirm: { limit: 10, windowMs: 10 * 60 * 1000 },
} as const;

/**
 * Authenticated-API budgets (per user + route). Mitigates member-driven
 * abuse of expensive endpoints (checkout, drain/sweep, sync, invites).
 * Same in-memory backing as auth limits; swap for Redis in multi-instance
 * deploys without changing call sites.
 */
export const API_RATE_LIMITS = {
  checkout: { limit: 10, windowMs: 10 * 60 * 1000 },
  automationExpensive: { limit: 20, windowMs: 5 * 60 * 1000 },
  notificationSync: { limit: 30, windowMs: 5 * 60 * 1000 },
  memberInvite: { limit: 20, windowMs: 10 * 60 * 1000 },
  messageSend: { limit: 60, windowMs: 5 * 60 * 1000 },
  ipnPerIp: { limit: 60, windowMs: 5 * 60 * 1000 },
  ipnPerTran: { limit: 20, windowMs: 5 * 60 * 1000 },
} as const;

/** Process-wide limiter for authenticated + public webhook routes. */
export const apiRateLimiter = new RateLimiter();
