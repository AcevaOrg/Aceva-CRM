/**
 * Pakistan local dates and times (plan section 22: stored in UTC, shown in Pakistan time).
 * Pakistan Standard Time is UTC+5 all year (no daylight saving), so plain arithmetic is exact.
 * Days are 'YYYY-MM-DD' strings, months 'YYYY-MM'. Shared by M7, M8 and M9.
 */
export const PKT_OFFSET_MS = 5 * 3600_000;
const DAY_MS = 86_400_000;

/** The Pakistan calendar day of an instant. */
export function pkDate(instant: Date): string {
  return new Date(instant.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes after midnight in Pakistan of an instant (0..1439). */
export function pkMinuteOfDay(instant: Date): number {
  const local = new Date(instant.getTime() + PKT_OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** The UTC instant of a Pakistan day plus minutes after midnight. */
export function pkInstant(day: string, minuteOfDay = 0): Date {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - PKT_OFFSET_MS + minuteOfDay * 60_000);
}

/** A day as the Date that Prisma uses for a @db.Date column (midnight UTC of that calendar day). */
export function dbDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** A @db.Date value back to 'YYYY-MM-DD'. */
export function dayOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** ISO weekday of a day: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(day: string): number {
  const d = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Every day from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function firstDayOfMonth(month: string): string {
  return `${month}-01`;
}

export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
