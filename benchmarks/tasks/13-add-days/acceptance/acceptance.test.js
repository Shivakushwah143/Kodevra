import test from "node:test";
import assert from "node:assert/strict";
import { addDays } from "../src/dates.js";

test("acceptance: month and year boundaries", () => {
  assert.equal(addDays("2024-01-30", 3), "2024-02-02");
  assert.equal(addDays("2023-12-31", 1), "2024-01-01");
  assert.equal(addDays("2024-03-01", -1), "2024-02-29");
});

test("acceptance: leap-day arithmetic", () => {
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2023-02-28", 1), "2023-03-01");
  assert.equal(addDays("2024-02-29", 365), "2025-02-28");
});

test("acceptance: zero and large offsets", () => {
  assert.equal(addDays("2025-06-15", 0), "2025-06-15");
  assert.equal(addDays("2025-01-01", 365), "2026-01-01");
});
