/**
 * Fixed-window rate limiter.
 * `now` is injected so callers (and tests) control time.
 */
export function createRateLimiter({ limit, windowMs, now = () => Date.now() } = {}) {
  const hits = new Map();

  return {
    check(key) {
      const at = now();
      const recent = (hits.get(key) ?? []).filter((time) => at - time < windowMs);

      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }

      recent.push(at);
      hits.set(key, recent);
      return true;
    },
  };
}
