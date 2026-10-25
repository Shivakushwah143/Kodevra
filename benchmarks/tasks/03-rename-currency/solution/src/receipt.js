import { formatCurrency } from "./money.js";

export function receiptLine(item) {
  return `${item.name}: ${formatCurrency(item.cents)}`;
}
