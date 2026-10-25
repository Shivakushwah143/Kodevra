import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/duration.js";

test("acceptance: combined durations sum both components", () => {
  assert.equal(parseDuration("1h30m"), 90);
  assert.equal(parseDuration("10h5m"), 605);
  assert.equal(parseDuration("0m"), 0);
});

test("acceptance: single component forms", () => {
  assert.equal(parseDuration("2h"), 120);
  assert.equal(parseDuration("90m"), 90);
});
