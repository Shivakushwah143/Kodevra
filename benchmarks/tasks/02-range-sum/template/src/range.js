export function sumRange(from, to) {
  let total = 0;
  for (let value = from; value < to; value += 1) {
    total += value;
  }
  return total;
}
