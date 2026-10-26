import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as moneyModule from "../src/money.js";
import { receiptLine } from "../src/receipt.js";
import { summaryLine } from "../src/summary.js";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

test("acceptance: formatCurrency is the only formatter export", () => {
  assert.equal(typeof moneyModule.formatCurrency, "function");
  assert.equal("formatMoney" in moneyModule, false);
  assert.equal(moneyModule.formatCurrency(1234), "$12.34");
  assert.equal(moneyModule.formatCurrency(0), "$0.00");
  assert.equal(moneyModule.formatCurrency(5), "$0.05");
  assert.equal(moneyModule.formatCurrency(-99), "-$0.99");
  assert.equal(moneyModule.formatCurrency(100000), "$1000.00");
});

test("acceptance: every consumer uses the renamed formatter", () => {
  assert.equal(receiptLine("Tea", 250), "Tea ... $2.50");
  assert.equal(summaryLine(3, 1050), "3 item(s): $10.50");
});

test("acceptance: no source file still mentions the old name", () => {
  const files = fs.readdirSync(srcDir).filter((file) => file.endsWith(".js"));
  assert.ok(files.length >= 3, `expected at least three source files, found ${files.length}`);
  for (const file of files) {
    const text = fs.readFileSync(path.join(srcDir, file), "utf8");
    assert.equal(text.includes("formatMoney"), false, `${file} still mentions formatMoney`);
  }
});
