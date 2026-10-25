/**
 * Parses a compact duration such as "2h", "45m" or "1h30m" into minutes.
 * Only hours and minutes are supported.
 */
export function parseDuration(text) {
  const hours = /(\d+)h/.exec(text);
  const minutes = /(\d+)m/.exec(text);

  const totalHours = hours ? Number(hours[1]) : 0;
  const totalMinutes = minutes ? Number(minutes[1]) : 0;
  return totalHours * 60 + totalMinutes;
}
