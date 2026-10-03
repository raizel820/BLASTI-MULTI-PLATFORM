export function getTodayStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

export function getTodayEnd(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}

/**
 * Format a Date as its LOCAL calendar date 'YYYY-MM-DD'.
 * Never use toISOString().split('T')[0] for user-picked dates — it converts to
 * UTC and shifts the day backwards for any timezone east of UTC (e.g. UTC+1):
 * a local-midnight Date becomes the PREVIOUS day, so the reservation is stored
 * one day earlier than the customer selected.
 */
export function toLocalDateString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
