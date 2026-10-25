import test from "node:test";
import assert from "node:assert/strict";
import { formatCurrency } from "../src/money.js";
import { receiptLine } from "../src/receipt.js";
import { invoiceLine } from "../src/invoice.js";

test("acceptance: the formatter keeps its behaviour", () => {
  assert.equal(formatCurrency(0), "$0.00");
  assert.equal(formatCurrency(123456), "$1234.56");
  assert.equal(formatCurrency(5), "$0.05");
});

test("acceptance: every caller uses the new name", () => {
  assert.equal(receiptLine({ name: "Mug", cents: 1500 }), "Mug: $15.00");
  assert.equal(invoiceLine([{ cents: 1000 }, { cents: 2500 }]), "2 items — $35.00");
  assert.equal(invoiceLine([{ cents: 700 }]), "1 item — $7.00");
});
