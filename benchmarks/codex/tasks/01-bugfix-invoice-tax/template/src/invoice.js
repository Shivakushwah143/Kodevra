/** Sales tax charged on every invoice. */
export const TAX_RATE = 0.0825;

export function lineTotal(item) {
  return item.price * item.quantity;
}

export function invoiceTotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}
