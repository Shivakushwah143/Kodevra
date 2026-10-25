import test from "node:test";
import assert from "node:assert/strict";
import { titleCase } from "../src/title.js";

test("acceptance: small words stay lowercase after the first word", () => {
  assert.equal(titleCase("the lord of the rings"), "The Lord of the Rings");
  assert.equal(titleCase("a tale of two cities"), "A Tale of Two Cities");
});

test("acceptance: acronyms survive", () => {
  assert.equal(titleCase("the api of http and the web"), "The API of HTTP and the Web");
});

test("acceptance: exception words keep their exact casing", () => {
  assert.equal(titleCase("the iphone app", ["iPhone"]), "The iPhone App");
  assert.equal(titleCase("using the openapi spec", ["OpenAPI"]), "Using the OpenAPI Spec");
});
