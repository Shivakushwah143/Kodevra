import test from "node:test";
import assert from "node:assert/strict";
import { validateSignup } from "../src/validate.js";

test("acceptance: a valid signup passes", () => {
  assert.deepEqual(validateSignup({ email: "a@b.co", password: "12345678" }), { ok: true, errors: [] });
});

test("acceptance: email rules", () => {
  assert.deepEqual(validateSignup({ email: "a@@b.co", password: "12345678" }).errors, ["email"]);
  assert.deepEqual(validateSignup({ email: "a@bco", password: "12345678" }).errors, ["email"]);
  assert.deepEqual(validateSignup({ email: "ab.co", password: "12345678" }).errors, ["email"]);
});

test("acceptance: password rules", () => {
  assert.deepEqual(validateSignup({ email: "a@b.co", password: "short1" }).errors, ["password"]);
  assert.deepEqual(validateSignup({ email: "a@b.co", password: "nodigits" }).errors, ["password"]);
});

test("acceptance: both fields can fail, in field order", () => {
  const result = validateSignup({ email: "nope", password: "short" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["email", "password"]);
  assert.deepEqual(validateSignup({}).errors, ["email", "password"]);
});
