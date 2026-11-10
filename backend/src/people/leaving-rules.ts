/** Pakistan Standard Time is UTC+5 all year (no daylight saving). */
const PKT_OFFSET_MS = 5 * 3600_000;

/** Today's date in Pakistan (YYYY-MM-DD). */
export function pakistanToday(now: Date): string {
  return new Date(now.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

/** The moment the last working day starts in Pakistan (00:00 PKT), as a UTC instant. */
export function startOfDayPakistan(isoDate: string): Date {
  return new Date(new Date(`${isoDate}T00:00:00.000Z`).getTime() - PKT_OFFSET_MS);
}

/** True when the last working day is today or already past, so leaving is processed immediately. */
export function isDue(lastWorkingDay: string, now: Date): boolean {
  return lastWorkingDay <= pakistanToday(now);
}
