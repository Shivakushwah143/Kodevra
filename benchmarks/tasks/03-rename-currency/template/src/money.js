export function formatPrice(cents) {
  const amount = (cents / 100).toFixed(2);
  return `$${amount}`;
}

export function formatCount(count) {
  return count === 1 ? "1 item" : `${count} items`;
}
