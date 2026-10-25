import { formatPrice } from "./money.js";

export function receiptLine(item) {
  return `${item.name}: ${formatPrice(item.cents)}`;
}
