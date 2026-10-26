/** Sales tax charged on every invoice. */
export const TAX_RATE = 0.0825;

export function lineTotal(item) {
  return item.price * item.quantity;
}

/** Money is compared at cent precision, so the tax result is rounded once. */
function roundCents(value) {
  return Math.round(value * 100) / 100;
}

export function invoiceTotal(items) {
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
  return roundCents(subtotal * (1 + TAX_RATE));
}
