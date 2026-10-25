import test from "node:test";
import assert from "node:assert/strict";
import { validateForm } from "../src/form.js";
import { validateEmail } from "../src/validate.js";

test("validateForm reports both field errors", () => {
  assert.deepEqual(validateForm({ email: "nope", name: "a" }), {
    ok: false,
    errors: { email: "invalid email", name: "name is too short" },
  });
});

test("validateForm accepts a valid signup", () => {
  assert.deepEqual(validateForm({ email: "dev@example.com", name: "Ada" }), { ok: true, errors: {} });
});

test("validateEmail is reusable on its own", () => {
  assert.equal(validateEmail("dev@example.com"), true);
  assert.equal(validateEmail("dev@example"), false);
});
