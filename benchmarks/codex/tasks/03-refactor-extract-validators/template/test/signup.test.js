import test from "node:test";
import assert from "node:assert/strict";

import { validateSignup } from "../src/signup.js";
import { validateEmail, validatePassword } from "../src/validators.js";

test("current signup validation reports both fields in order", () => {
  assert.deepEqual(validateSignup({ email: "", password: "" }), ["Email is required", "Password is required"]);
  assert.deepEqual(validateSignup({ email: "ada", password: "short" }), [
    "Email is invalid",
    "Password must be at least 8 characters",
  ]);
});

test("current signup validation accepts a valid signup", () => {
  assert.deepEqual(validateSignup({ email: "ada@lovelace.dev", password: "analytical" }), []);
});

test("the extracted validators are reusable on their own", () => {
  assert.equal(validateEmail("ada"), "Email is invalid");
  assert.equal(validateEmail("ada@lovelace.dev"), null);
  assert.equal(validatePassword("short"), "Password must be at least 8 characters");
  assert.equal(validatePassword("analytical"), null);
});
