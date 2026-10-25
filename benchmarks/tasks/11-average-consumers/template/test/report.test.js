import test from "node:test";
import assert from "node:assert/strict";
import { average } from "../src/stats.js";
import { buildReport } from "../src/report.js";
import { summarize } from "../src/summary.js";

test("averages a score list", () => {
  assert.equal(average([80, 60]), 70);
});

test("an empty score list averages to zero", () => {
  assert.equal(average([]), 0);
});

test("both consumers keep the empty case working", () => {
  assert.deepEqual(buildReport([]), { mean: 0, grade: "review" });
  assert.equal(summarize([]), "Average: 0");
});
