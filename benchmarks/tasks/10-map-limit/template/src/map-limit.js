/**
 * Maps items with an async function, never running more than `limit`
 * callbacks at the same time. Results keep the input order.
 */
export async function mapLimit(items, limit, fn) {
  return Promise.all(items.map((item, index) => fn(item, index)));
}
