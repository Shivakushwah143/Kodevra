/** Arithmetic mean of a list of numbers; an empty list averages to 0. */
export function average(values) {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}
