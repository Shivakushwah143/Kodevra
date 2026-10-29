import test from "node:test";
import assert from "node:assert/strict";

import { invoiceTotal, lineTotal } from "../src/invoice.js";

test("line total multiplies price by quantity", () => {
  assert.equal(lineTotal({ price: 10, quantity: 3 }), 30);
});

test("invoice total includes sales tax", () => {
  assert.equal(invoiceTotal([{ price: 100, quantity: 1 }]), 108.25);
});

test("invoice total rounds tax to cents", () => {
  assert.equal(invoiceTotal([{ price: 19.99, quantity: 3 }]), 64.92);
});
