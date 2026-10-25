export function parseCsvLine(line) {
  if (line === "") return [];
  return line.split(",");
}
