import test from "node:test";
import assert from "node:assert/strict";
import { sortRows } from "../src/sort.js";

test("acceptance: secondary keys and descending order", () => {
  const rows = [
    { team: "blue", score: 3 },
    { team: "red", score: 9 },
    { team: "blue", score: 7 },
  ];
  const sorted = sortRows(rows, [{ key: "team" }, { key: "score", direction: "desc" }]);
  assert.deepEqual(sorted.map((row) => `${row.team}:${row.score}`), ["blue:7", "blue:3", "red:9"]);
});

test("acceptance: ties keep the original order", () => {
  const rows = [
    { group: "x", name: "first" },
    { group: "x", name: "second" },
    { group: "x", name: "third" },
  ];
  assert.deepEqual(sortRows(rows, [{ key: "group" }]).map((row) => row.name), ["first", "second", "third"]);
});

test("acceptance: the input array is not mutated", () => {
  const rows = [{ score: 2 }, { score: 5 }, { score: 1 }];
  sortRows(rows, [{ key: "score", direction: "desc" }]);
  assert.deepEqual(rows.map((row) => row.score), [2, 5, 1]);
});
