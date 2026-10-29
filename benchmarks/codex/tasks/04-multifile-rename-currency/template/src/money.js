/** Render an amount in cents as a dollar string, for example 1234 -> "$12.34". */
export function formatMoney(cents) {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${remainder}`;
}
