import test from "node:test";
import assert from "node:assert/strict";
import { sumRange } from "../src/range.js";

test("sumRange includes both ends", () => {
  assert.equal(sumRange(1, 3), 6);
});

test("sumRange of a single number is that number", () => {
  assert.equal(sumRange(5, 5), 5);
});
