import test from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/paginate.js";

const alphabet = ["a", "b", "c", "d", "e"];

test("acceptance: middle page navigates both ways", () => {
  const result = paginate(alphabet, { page: 2, pageSize: 2 });
  assert.deepEqual(result.items, ["c", "d"]);
  assert.equal(result.totalPages, 3);
  assert.equal(result.hasNext, true);
  assert.equal(result.hasPrev, true);
});

test("acceptance: page below one clamps to the first page", () => {
  const result = paginate(alphabet, { page: 0, pageSize: 2 });
  assert.equal(result.page, 1);
  assert.deepEqual(result.items, ["a", "b"]);
  assert.equal(result.hasPrev, false);
});

test("acceptance: page size is clamped to 1..100", () => {
  const tooBig = paginate(alphabet, { page: 1, pageSize: 1000 });
  assert.equal(tooBig.pageSize, 100);
  assert.equal(tooBig.totalPages, 1);

  const tooSmall = paginate(alphabet, { page: 1, pageSize: 0 });
  assert.equal(tooSmall.pageSize, 1);
  assert.deepEqual(tooSmall.items, ["a"]);
  assert.equal(tooSmall.totalPages, 5);
});

test("acceptance: an empty collection has no pages", () => {
  const result = paginate([], { page: 2, pageSize: 10 });
  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);
  assert.equal(result.totalPages, 0);
  assert.equal(result.hasNext, false);
  assert.equal(result.hasPrev, false);
});
