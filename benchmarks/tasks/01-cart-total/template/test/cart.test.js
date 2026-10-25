import test from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/cart.js";

test("total adds item prices", () => {
  assert.equal(total([{ price: 5, quantity: 1 }, { price: 3, quantity: 1 }]), 8);
});

test("total respects quantity", () => {
  assert.equal(total([{ price: 5, quantity: 2 }, { price: 3, quantity: 1 }]), 13);
});
