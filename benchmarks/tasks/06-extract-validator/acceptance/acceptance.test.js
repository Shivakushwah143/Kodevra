import test from "node:test";
import assert from "node:assert/strict";
import { validateForm } from "../src/form.js";
import { validateEmail } from "../src/validate.js";

test("acceptance: validateEmail is exported and reusable", () => {
  assert.equal(validateEmail("ada@example.com"), true);
  assert.equal(validateEmail("ada@example"), false);
  assert.equal(validateEmail(""), false);
  assert.equal(validateEmail(undefined), false);
});

test("acceptance: validateForm behavior is unchanged", () => {
  assert.deepEqual(validateForm({ email: "ada@example.com", name: "Ada" }), { ok: true, errors: {} });
  assert.deepEqual(validateForm({ email: "bad", name: "Ada" }), { ok: false, errors: { email: "invalid email" } });
  assert.deepEqual(validateForm({ email: "ada@example.com", name: " A " }), { ok: false, errors: { name: "name is too short" } });
});
