/** RFC 4180 field boundary: comma, double quote, carriage return, newline. */
const NEEDS_QUOTING = /[",\r\n]/;

function formatField(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serialize rows of objects as CSV.
 *
 * The header comes from the first row's keys. Only fields that contain a comma,
 * a double quote, a carriage return or a newline are quoted, and internal quotes
 * are doubled so the output can be parsed back.
 */
export function toCsv(rows) {
  if (!rows.length) return "";
  const header = Object.keys(rows[0]);
  const lines = [header.map(formatField).join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => formatField(row[key])).join(","));
  }
  return lines.join("\n");
}
