import test from "node:test";
import assert from "node:assert/strict";
import { createLruCache } from "../src/lru.js";

test("acceptance: reads refresh recency", () => {
  const cache = createLruCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined, "b was the least recently used");
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("acceptance: updating a key does not grow the cache", () => {
  const cache = createLruCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 9);
  assert.equal(cache.size, 2);
  assert.equal(cache.get("a"), 9);
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined, "b was least recently used after a update");
  assert.equal(cache.get("a"), 9);
});

test("acceptance: capacity one keeps only the newest key", () => {
  const cache = createLruCache(1);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.size, 1);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
});
