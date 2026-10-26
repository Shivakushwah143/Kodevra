import test from "node:test";
import assert from "node:assert/strict";

import { toCsv } from "../src/csv.js";

test("acceptance: no rows produce an empty export", () => {
  assert.equal(toCsv([]), "");
});

test("acceptance: the header keeps the first row's key order", () => {
  assert.equal(toCsv([{ second: 1, first: 2 }]), "second,first\n1,2");
});

test("acceptance: fields are quoted only when they need it", () => {
  assert.equal(toCsv([{ name: "Ada Lovelace" }]), "name\nAda Lovelace");
  assert.equal(toCsv([{ note: "a\rb" }]), 'note\n"a\rb"');
});

test("acceptance: null and undefined become empty fields", () => {
  assert.equal(toCsv([{ a: null, b: undefined, c: 0 }]), "a,b,c\n,,0");
});

test("acceptance: numbers and booleans are stringified", () => {
  assert.equal(toCsv([{ n: 1.5, ok: true }]), "n,ok\n1.5,true");
});

test("acceptance: every row uses the same header and missing keys are empty", () => {
  const rows = [
    { name: "Ada", note: "a,b" },
    { name: "Grace" },
  ];
  assert.equal(toCsv(rows), 'name,note\nAda,"a,b"\nGrace,');
});

test("acceptance: the export has no trailing newline", () => {
  const output = toCsv([{ a: 1 }, { a: 2 }]);
  assert.equal(output, "a\n1\n2");
  assert.equal(output.endsWith("\n"), false);
});
