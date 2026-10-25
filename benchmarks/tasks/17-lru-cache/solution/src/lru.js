export function createLruCache(capacity = 10) {
  const limit = Math.max(1, Math.floor(Number(capacity) || 1));
  const store = new Map();

  return {
    get(key) {
      if (!store.has(key)) return undefined;
      const value = store.get(key);
      store.delete(key);
      store.set(key, value);
      return value;
    },
    set(key, value) {
      if (store.has(key)) store.delete(key);
      store.set(key, value);
      while (store.size > limit) {
        const oldest = store.keys().next().value;
        store.delete(oldest);
      }
    },
    get size() {
      return store.size;
    },
    get capacity() {
      return limit;
    },
  };
}
