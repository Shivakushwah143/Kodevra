export function sortRows(rows, keys) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      for (const { key, direction = "asc" } of keys) {
        if (left.row[key] === right.row[key]) continue;
        const order = left.row[key] > right.row[key] ? 1 : -1;
        return direction === "desc" ? -order : order;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.row);
}
