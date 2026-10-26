/**
 * Serialize rows of objects as CSV.
 *
 * The header comes from the first row's keys. Values are written as they are:
 * this implementation performs no escaping at all.
 */
export function toCsv(rows) {
  if (!rows.length) return "";
  const header = Object.keys(rows[0]);
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => String(row[key])).join(","));
  }
  return lines.join("\n");
}
