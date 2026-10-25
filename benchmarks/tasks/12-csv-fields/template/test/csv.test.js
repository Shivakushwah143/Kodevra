import test from "node:test";
import assert from "node:assert/strict";
import { parseCsvLine } from "../src/csv.js";

test("splits a simple line on commas", () => {
  assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
});

test("keeps a quoted comma inside one field", () => {
  assert.deepEqual(parseCsvLine('"hello, world",2'), ["hello, world", "2"]);
});
