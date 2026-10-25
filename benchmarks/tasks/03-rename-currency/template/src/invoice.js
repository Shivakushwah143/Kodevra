import { formatCount, formatPrice } from "./money.js";

export function invoiceLine(items) {
  const total = items.reduce((sum, item) => sum + item.cents, 0);
  return `${formatCount(items.length)} — ${formatPrice(total)}`;
}
