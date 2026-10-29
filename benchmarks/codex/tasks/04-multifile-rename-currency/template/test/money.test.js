import test from "node:test";
import assert from "node:assert/strict";

import { formatCurrency } from "../src/money.js";
import { receiptLine } from "../src/receipt.js";
import { summaryLine } from "../src/summary.js";

test("formatCurrency renders cents as dollars", () => {
  assert.equal(formatCurrency(1234), "$12.34");
  assert.equal(formatCurrency(0), "$0.00");
});

test("formatCurrency renders negative amounts", () => {
  assert.equal(formatCurrency(-99), "-$0.99");
});

test("receiptLine keeps the same rendered row", () => {
  assert.equal(receiptLine("Coffee", 350), "Coffee ... $3.50");
});

test("summaryLine keeps the same rendered row", () => {
  assert.equal(summaryLine(2, 700), "2 item(s): $7.00");
});
