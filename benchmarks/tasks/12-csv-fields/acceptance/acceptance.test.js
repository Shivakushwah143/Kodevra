import test from "node:test";
import assert from "node:assert/strict";
import { parseCsvLine } from "../src/csv.js";

test("acceptance: quoted commas and empty fields", () => {
  assert.deepEqual(parseCsvLine('"a,b",c'), ["a,b", "c"]);
  assert.deepEqual(parseCsvLine("a,,b"), ["a", "", "b"]);
  assert.deepEqual(parseCsvLine(""), []);
});

test("acceptance: escaped quotes inside a quoted field", () => {
  assert.deepEqual(parseCsvLine('"He said ""hi""",x'), ['He said "hi"', "x"]);
});

test("acceptance: several quoted fields in one row", () => {
  assert.deepEqual(parseCsvLine('"one,two","three,four",5'), ["one,two", "three,four", "5"]);
  assert.deepEqual(parseCsvLine('""'), [""]);
});
