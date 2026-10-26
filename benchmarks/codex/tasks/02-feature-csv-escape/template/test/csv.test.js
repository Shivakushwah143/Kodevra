import test from "node:test";
import assert from "node:assert/strict";

import { toCsv } from "../src/csv.js";

test("a simple row needs no quoting", () => {
  assert.equal(toCsv([{ name: "Ada", age: 36 }]), "name,age\nAda,36");
});

test("a comma inside a value is quoted", () => {
  assert.equal(
    toCsv([{ name: "Ada, Lovelace", city: "London" }]),
    'name,city\n"Ada, Lovelace",London',
  );
});

test("a double quote is doubled inside a quoted value", () => {
  assert.equal(toCsv([{ note: 'say "hi"' }]), 'note\n"say ""hi"""');
});

test("a newline stays inside one quoted field", () => {
  assert.equal(toCsv([{ note: "line one\nline two" }]), 'note\n"line one\nline two"');
});
