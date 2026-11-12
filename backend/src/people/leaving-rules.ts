/** Pakistan Standard Time is UTC+5 all year (no daylight saving). */
const PKT_OFFSET_MS = 5 * 3600_000;

/** Today's date in Pakistan (YYYY-MM-DD). */
export function pakistanToday(now: Date): string {
  return new Date(now.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

/** The moment the day after the last working day starts in Pakistan (00:00 PKT), as a UTC instant. Access ends then. */
export function accessEndsAt(lastWorkingDay: string): Date {
  const next = new Date(new Date(`${lastWorkingDay}T00:00:00.000Z`).getTime() + 86_400_000);
  return new Date(next.getTime() - PKT_OFFSET_MS);
}

/** True once the last working day is over (it is a later Pakistan day than the last working day), so leaving is processed. */
export function isDue(lastWorkingDay: string, now: Date): boolean {
  return pakistanToday(now) > lastWorkingDay;
}
