import test from "node:test";
import assert from "node:assert/strict";
import { titleCase } from "../src/title.js";

test("capitalises the first word", () => {
  assert.equal(titleCase("hello world"), "Hello World");
});

test("keeps small words lowercase after the first word", () => {
  assert.equal(titleCase("the lord of the rings"), "The Lord of the Rings");
});
