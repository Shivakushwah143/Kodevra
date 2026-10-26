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
        const result = flush(items);
        items.length = 0;
        return result;
      }
      return false;
    },
  };
}
