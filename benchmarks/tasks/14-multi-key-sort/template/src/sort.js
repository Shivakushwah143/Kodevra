export function sortRows(rows, keys) {
  const { key } = keys[0];
  return rows.sort((left, right) => (left[key] > right[key] ? 1 : -1));
}
