import {
  addDays,
  differenceInCalendarDays,
  formatDistanceToNowStrict,
  isWeekend,
  startOfDay,
} from "date-fns";

/** All times are stored in UTC and shown in Pakistan time (plan §22). */
export const TIME_ZONE = "Asia/Karachi";
const LOCALE = "en-GB";

type DateInput = string | number | Date;
const toDate = (d: DateInput) => (d instanceof Date ? d : new Date(d));

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, ...opts });

const F = {
  date: fmt({ day: "numeric", month: "short", year: "numeric" }),
  dateShort: fmt({ day: "numeric", month: "short" }),
  time: fmt({ hour: "2-digit", minute: "2-digit", hour12: false }),
  weekday: fmt({ weekday: "short" }),
  weekdayLong: fmt({ weekday: "long", day: "numeric", month: "long" }),
  month: fmt({ month: "long", year: "numeric" }),
  monthShort: fmt({ month: "short" }),
};

/** 9 Nov 2026 */
export const formatDate = (d: DateInput) => F.date.format(toDate(d));
/** 9 Nov */
export const formatDateShort = (d: DateInput) => F.dateShort.format(toDate(d));
/** 09:02 */
export const formatTime = (d: DateInput) => F.time.format(toDate(d));
/** 9 Nov 2026, 09:02 */
export const formatDateTime = (d: DateInput) => `${formatDate(d)}, ${formatTime(d)}`;
/** Mon */
export const formatWeekday = (d: DateInput) => F.weekday.format(toDate(d));
/** Monday 9 November */
export const formatWeekdayLong = (d: DateInput) => F.weekdayLong.format(toDate(d));
/** November 2026 */
export const formatMonth = (d: DateInput) => F.month.format(toDate(d));
/** Nov */
export const formatMonthShort = (d: DateInput) => F.monthShort.format(toDate(d));

/** "3 hours ago" / "in 2 days" */
export function formatRelative(d: DateInput) {
  return formatDistanceToNowStrict(toDate(d), { addSuffix: true });
}

/** "2026-11" → "November 2026" */
export function formatMonthKey(key: string) {
  const [y, m] = key.split("-").map(Number);
  return formatMonth(new Date(y, m - 1, 15));
}

export function monthKey(d: DateInput = new Date()) {
  const x = toDate(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
}

export function isoDay(d: DateInput) {
  const x = toDate(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

export function greeting(d: Date = new Date()) {
  const h = d.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/* ---------- Working days (tasks, leave, payroll) ---------- */

export function isWorkingDay(d: DateInput, holidays: string[] = []) {
  const x = toDate(d);
  return !isWeekend(x) && !holidays.includes(isoDay(x));
}

/** Add N working days, skipping weekends and holidays (plan §9 suggested deadline). */
export function addWorkingDays(start: DateInput, days: number, holidays: string[] = []) {
  let d = startOfDay(toDate(start));
  let added = 0;
  if (days === 0) {
    while (!isWorkingDay(d, holidays)) d = addDays(d, 1);
    return d;
  }
  while (added < days) {
    d = addDays(d, 1);
    if (isWorkingDay(d, holidays)) added++;
  }
  return d;
}

/** Working days from a to b inclusive. */
export function workingDaysBetween(a: DateInput, b: DateInput, holidays: string[] = []) {
  let d = startOfDay(toDate(a));
  const end = startOfDay(toDate(b));
  let n = 0;
  while (d <= end) {
    if (isWorkingDay(d, holidays)) n++;
    d = addDays(d, 1);
  }
  return n;
}

export type DueTone = "overdue" | "today" | "soon" | "later" | "done";

/** Deadline chip text and tone (spec §3.5, DeadlineChip). */
export function dueInfo(deadline: DateInput, now: Date = new Date()): { label: string; tone: DueTone } {
  const d = toDate(deadline);
  const days = differenceInCalendarDays(d, now);
  if (d.getTime() < now.getTime()) {
    const late = Math.max(1, -days);
    return { label: days === 0 ? "Overdue today" : `${late} day${late === 1 ? "" : "s"} overdue`, tone: "overdue" };
  }
  if (days === 0) return { label: `Today ${formatTime(d)}`, tone: "today" };
  if (days === 1) return { label: "Tomorrow", tone: "soon" };
  if (days <= 3) return { label: `In ${days} days`, tone: "soon" };
  return { label: formatDateShort(d), tone: "later" };
}
