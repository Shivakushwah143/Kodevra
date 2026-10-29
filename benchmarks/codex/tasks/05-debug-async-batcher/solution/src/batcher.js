/**
 * Group items and hand each full batch to `flush`.
 *
 * add(item) returns false when the item did not complete a batch, otherwise it
 * returns whatever flush returned (a value or a promise).
 */
export function createBatcher({ flush, maxSize = 2 }) {
  let items = [];

  return {
    add(item) {
      items.push(item);
      if (items.length >= maxSize) {
        // The batch is snapshotted and the buffer swapped before flush runs:
        // an async flush must never observe the next batch's items, and the
        // buffer must already be clean if flush rejects.
        const batch = items;
        items = [];
        return flush(batch);
      }
      return false;
    },
  };
}
