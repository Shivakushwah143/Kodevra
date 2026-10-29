import { formatCurrency } from "./money.js";

/** One receipt row: the item name, a separator and the formatted amount. */
export function receiptLine(name, cents) {
  return `${name} ... ${formatCurrency(cents)}`;
}
