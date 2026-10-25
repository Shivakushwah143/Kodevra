// A cache that keeps everything: capacity is accepted but never applied.
export function createLruCache(capacity = 10) {
  const store = new Map();

  return {
    get(key) {
      return store.get(key);
    },
    set(key, value) {
      store.set(key, value);
    },
    get size() {
      return store.size;
    },
    get capacity() {
      return capacity;
    },
  };
}
