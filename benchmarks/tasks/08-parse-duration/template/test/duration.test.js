import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/duration.js";

test("minutes only", () => {
  assert.equal(parseDuration("45m"), 45);
});

test("hours only", () => {
  assert.equal(parseDuration("2h"), 120);
});

test("hours and minutes together", () => {
  assert.equal(parseDuration("1h30m"), 90);
});
