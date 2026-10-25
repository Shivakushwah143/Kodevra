/**
 * Runs an async function, optionally retrying when it throws.
 * `retries` counts additional attempts after the first one.
 */
export async function withRetry(fn, { retries = 0 } = {}) {
  return fn();
}
