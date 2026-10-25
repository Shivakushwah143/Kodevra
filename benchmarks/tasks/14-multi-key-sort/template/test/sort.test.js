import test from "node:test";
import assert from "node:assert/strict";
import { sortRows } from "../src/sort.js";

test("sorts by one key ascending", () => {
  const rows = [{ name: "b" }, { name: "a" }, { name: "c" }];
  assert.deepEqual(sortRows(rows, [{ key: "name" }]).map((row) => row.name), ["a", "b", "c"]);
});

test("does not reorder the caller's array", () => {
  const rows = [{ name: "b" }, { name: "a" }];
  sortRows(rows, [{ key: "name" }]);
  assert.deepEqual(rows.map((row) => row.name), ["b", "a"]);
});
