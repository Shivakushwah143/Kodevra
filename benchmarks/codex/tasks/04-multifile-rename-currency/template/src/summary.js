import { formatMoney } from "./money.js";

/** One summary row: how many items and what they cost together. */
export function summaryLine(count, cents) {
  return `${count} item(s): ${formatMoney(cents)}`;
}
