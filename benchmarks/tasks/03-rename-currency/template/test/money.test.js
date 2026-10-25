import test from "node:test";
import assert from "node:assert/strict";
import { formatCurrency } from "../src/money.js";
import { receiptLine } from "../src/receipt.js";

test("formatCurrency renders cents as dollars", () => {
  assert.equal(formatCurrency(1999), "$19.99");
});

test("receiptLine uses the renamed formatter", () => {
  assert.equal(receiptLine({ name: "Tea", cents: 250 }), "Tea: $2.50");
});
