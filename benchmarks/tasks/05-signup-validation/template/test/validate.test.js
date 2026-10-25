import test from "node:test";
import assert from "node:assert/strict";
import { validateSignup } from "../src/validate.js";

test("a valid signup is accepted", () => {
  assert.deepEqual(validateSignup({ email: "ada@example.com", password: "lovelace1" }), { ok: true, errors: [] });
});

test("an email without an @ is rejected", () => {
  const result = validateSignup({ email: "ada.example.com", password: "lovelace1" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["email"]);
});
