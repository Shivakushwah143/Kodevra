import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateSignup } from "../src/signup.js";
import { validateEmail, validatePassword } from "../src/validators.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("acceptance: email messages and precedence are unchanged", () => {
  assert.equal(validateEmail(""), "Email is required");
  assert.equal(validateEmail(undefined), "Email is required");
  assert.equal(validateEmail("ada"), "Email is invalid");
  assert.equal(validateEmail("ada@"), "Email is invalid");
  assert.equal(validateEmail("ada@lovelace.dev"), null);
});

test("acceptance: password messages and precedence are unchanged", () => {
  assert.equal(validatePassword(""), "Password is required");
  assert.equal(validatePassword(undefined), "Password is required");
  assert.equal(validatePassword("short"), "Password must be at least 8 characters");
  assert.equal(validatePassword("exactly8"), null);
});

test("acceptance: validateSignup returns both errors in field order", () => {
  assert.deepEqual(validateSignup({ email: "ada", password: "short" }), [
    "Email is invalid",
    "Password must be at least 8 characters",
  ]);
  assert.deepEqual(validateSignup({ email: "ada@lovelace.dev" }), ["Password is required"]);
  assert.deepEqual(validateSignup({ password: "analytical" }), ["Email is required"]);
  assert.deepEqual(validateSignup({}), ["Email is required", "Password is required"]);
  assert.deepEqual(validateSignup({ email: "ada@lovelace.dev", password: "analytical" }), []);
});

test("acceptance: the validators module does not depend on signup", () => {
  const text = fs.readFileSync(path.join(here, "../src/validators.js"), "utf8");
  assert.doesNotMatch(text, /from\s+["'][^"']*signup\.js["']/);
});
