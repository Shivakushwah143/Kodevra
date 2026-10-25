/**
 * Fixed-window rate limiter.
 * `now` is injected so callers (and tests) control time.
 */
export function createRateLimiter({ limit, windowMs, now = () => Date.now() } = {}) {
  const hits = [];

  return {
    check(key) {
      hits.push({ key, at: now() });
      const used = hits.filter((hit) => hit.key === key).length;
      return used <= limit;
    },
  };
}
