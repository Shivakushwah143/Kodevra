import test from "node:test";
import assert from "node:assert/strict";

import { TAX_RATE, invoiceTotal } from "../src/invoice.js";

test("acceptance: tax is applied to the summed subtotal", () => {
  const items = [
    { price: 12.5, quantity: 2 },
    { price: 4.25, quantity: 4 },
  ];
  assert.equal(invoiceTotal(items), 45.47);
});

test("acceptance: the documented tax rate is the one applied", () => {
  assert.equal(TAX_RATE, 0.0825);
  assert.equal(invoiceTotal([{ price: 200, quantity: 1 }]), 216.5);
});

test("acceptance: an empty invoice costs nothing", () => {
  assert.equal(invoiceTotal([]), 0);
});
