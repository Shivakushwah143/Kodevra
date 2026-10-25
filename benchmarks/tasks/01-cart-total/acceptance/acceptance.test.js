import test from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/cart.js";

test("acceptance: quantity multiplies price", () => {
  assert.equal(total([{ price: 5, quantity: 2 }, { price: 3, quantity: 1 }]), 13);
  assert.equal(total([]), 0);
  assert.equal(total([{ price: 2.5, quantity: 4 }]), 10);
});

test("acceptance: a missing quantity counts as one", () => {
  assert.equal(total([{ price: 7 }]), 7);
});
