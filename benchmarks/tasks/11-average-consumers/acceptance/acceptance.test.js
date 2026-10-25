import test from "node:test";
import assert from "node:assert/strict";
import { average } from "../src/stats.js";
import { buildReport } from "../src/report.js";
import { summarize } from "../src/summary.js";

test("acceptance: average is zero for an empty list", () => {
  assert.equal(average([]), 0);
  assert.equal(average([0]), 0);
});

test("acceptance: both consumers report the empty case without NaN", () => {
  assert.deepEqual(buildReport([]), { mean: 0, grade: "review" });
  assert.equal(summarize([]), "Average: 0");
  assert.doesNotMatch(summarize([]), /NaN/);
});

test("acceptance: non-empty behaviour is unchanged", () => {
  assert.equal(average([80, 60]), 70);
  assert.deepEqual(buildReport([80, 60]), { mean: 70, grade: "pass" });
  assert.deepEqual(buildReport([50]), { mean: 50, grade: "review" });
  assert.equal(summarize([70, 80]), "Average: 75");
});
