/**
 * Parses a compact duration such as "2h", "45m" or "1h30m" into minutes.
 * Only hours and minutes are supported.
 */
export function parseDuration(text) {
  const hours = /(\d+)h/.exec(text);
  const minutes = /(\d+)m/.exec(text);

  if (hours) return Number(hours[1]) * 60;
  if (minutes) return Number(minutes[1]);
  return 0;
}
