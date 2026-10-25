import test from "node:test";
import assert from "node:assert/strict";
import { addDays } from "../src/dates.js";

test("adds days inside one month", () => {
  assert.equal(addDays("2024-01-10", 5), "2024-01-15");
});

test("adds days across a month boundary", () => {
  assert.equal(addDays("2024-01-30", 3), "2024-02-02");
});
