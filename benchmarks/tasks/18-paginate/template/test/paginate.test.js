import test from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/paginate.js";

const alphabet = ["a", "b", "c", "d", "e"];

test("a page contains the matching slice", () => {
  const result = paginate(alphabet, { page: 1, pageSize: 2 });
  assert.deepEqual(result.items, ["a", "b"]);
  assert.equal(result.total, 5);
});

test("page metadata describes the whole collection", () => {
  const result = paginate(alphabet, { page: 1, pageSize: 2 });
  assert.equal(result.totalPages, 3);
  assert.equal(result.hasNext, true);
  assert.equal(result.hasPrev, false);
});
