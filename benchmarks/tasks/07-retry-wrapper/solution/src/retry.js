/**
 * Runs an async function, optionally retrying when it throws.
 * `retries` counts additional attempts after the first one.
 */
export async function withRetry(fn, { retries = 0 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
