import test from "node:test";
import assert from "node:assert/strict";
import { sumRange } from "../src/range.js";

test("acceptance: both bounds are included", () => {
  assert.equal(sumRange(1, 3), 6);
  assert.equal(sumRange(5, 5), 5);
  assert.equal(sumRange(0, 0), 0);
});

test("acceptance: negative ranges work", () => {
  assert.equal(sumRange(-2, 2), 0);
  assert.equal(sumRange(-3, -1), -6);
});

test("acceptance: a reversed range adds nothing", () => {
  assert.equal(sumRange(3, 1), 0);
});
