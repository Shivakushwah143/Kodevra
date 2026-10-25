/**
 * Maps items with an async function, never running more than `limit`
 * callbacks at the same time. Results keep the input order.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  const workers = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
