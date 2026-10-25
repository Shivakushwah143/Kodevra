export function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${year}-${String(month).padStart(2, "0")}-${String(day + days).padStart(2, "0")}`;
}
