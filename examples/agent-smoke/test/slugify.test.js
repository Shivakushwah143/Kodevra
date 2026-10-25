import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("slugify produces stable url slugs", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Node.js & AI  "), "nodejs-ai");
});
