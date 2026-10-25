import test from "node:test";
import assert from "node:assert/strict";
import { createLruCache } from "../src/lru.js";

test("values are stored and read back", () => {
  const cache = createLruCache(2);
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("missing"), undefined);
});

test("capacity is enforced", () => {
  const cache = createLruCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), 3);
});
