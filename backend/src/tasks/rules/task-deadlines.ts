/**
 * Task deadline rules (plan section 9, "Deadline rules"). Pure functions: no Nest, no database.
 *
 * All calendar work is done on Pakistan days ("YYYY-MM-DD", UTC+5, no daylight saving). Working days are Monday to
 * Friday minus the company holidays. A suggested deadline is 18:00 Pakistan time on the last working day.
 */
import type { TaskSizeName } from '@aceva/contracts';
import { dayWindow, MINUTE_MS, pakistanDay } from '../../activity/rules/activity-time';

/** The hour (Pakistan time) a suggested deadline falls on. */
export const DEADLINE_HOUR_PKT = 18;
const HOUR_MS = 60 * MINUTE_MS;

export type DaySet = ReadonlySet<string> | readonly string[];
const has = (days: DaySet, day: string): boolean => (Array.isArray(days) ? days.includes(day) : (days as ReadonlySet<string>).has(day));

/** What is wrong with a task, or what the person should confirm. `message` is the sentence to show. */
export interface TaskIssue {
  code: string;
  message: string;
  details?: Record<string, string | number>;
}

/** 0 = Sunday ... 6 = Saturday, for a Pakistan day. */
export const weekdayOf = (day: string): number => new Date(`${day}T00:00:00.000Z`).getUTCDay();
/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export const isoWeekdayOf = (day: string): number => weekdayOf(day) || 7;

export function addDays(day: string, n: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

export function isWorkingDay(day: string, holidays: DaySet = []): boolean {
  const w = weekdayOf(day);
  return w !== 0 && w !== 6 && !has(holidays, day);
}

/** The first working day on or after `day`. */
export function nextWorkingDay(day: string, holidays: DaySet = []): string {
  let d = day;
  while (!isWorkingDay(d, holidays)) d = addDays(d, 1);
  return d;
}

/**
 * `days` working days after `startDay`, skipping weekends and holidays. Zero days means the same day, or the next working
 * day when `startDay` is not one ("same working day").
 */
export function addWorkingDays(startDay: string, days: number, holidays: DaySet = []): string {
  if (days <= 0) return nextWorkingDay(startDay, holidays);
  let d = startDay;
  let added = 0;
  while (added < days) {
    d = addDays(d, 1);
    if (isWorkingDay(d, holidays)) added++;
  }
  return d;
}

const DAY_MS = 86_400_000;
/** Whole days since 1970-01-01 of a "YYYY-MM-DD" day (NaN when it is not a date). */
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
/** 0 = Sunday ... 6 = Saturday, for a day number (day 0, 1970-01-01, was a Thursday). */
const weekdayOfNumber = (n: number): number => (((n + 4) % 7) + 7) % 7;
const isWeekday = (n: number): boolean => {
  const w = weekdayOfNumber(n);
  return w !== 0 && w !== 6;
};

/**
 * Working days from `a` to `b`, both included (0 when b is before a). Counted by arithmetic on day numbers (five a week,
 * then the few days left over, minus the holidays that fall on a weekday in the range), never day by day, so a far-off
 * deadline costs the same as a near one.
 */
export function workingDaysBetween(a: string, b: string, holidays: DaySet = []): number {
  const first = dayNumber(a);
  const last = dayNumber(b);
  if (Number.isNaN(first) || Number.isNaN(last) || last < first) return 0;
  const weeks = Math.floor((last - first + 1) / 7);
  let count = weeks * 5;
  for (let n = first + weeks * 7; n <= last; n++) if (isWeekday(n)) count++;
  for (const holiday of new Set(holidays)) {
    const n = dayNumber(holiday);
    if (n >= first && n <= last && isWeekday(n)) count--;
  }
  return count;
}

/** The instant of a Pakistan day at a time of day ("HH:mm"). */
export function pakistanInstant(day: string, time = '00:00'): Date {
  const [h, m] = time.split(':').map(Number);
  return new Date(dayWindow(day).start.getTime() + h * HOUR_MS + m * MINUTE_MS);
}

/**
 * The deadline the system suggests when a size is picked: `days` working days after the start day (holidays skipped), at
 * 18:00 Pakistan time. Null when the size has no suggested days (XL: must be split). A suggestion that would not be after
 * the start (a same-day task started after 18:00) moves to the next working day.
 */
export function suggestedDeadline(start: Date, days: number | null, holidays: DaySet = []): Date | null {
  if (days === null) return null;
  let day = addWorkingDays(pakistanDay(start), days, holidays);
  let deadline = pakistanInstant(day, `${DEADLINE_HOUR_PKT}:00`);
  while (deadline.getTime() <= start.getTime()) {
    day = nextWorkingDay(addDays(day, 1), holidays);
    deadline = pakistanInstant(day, `${DEADLINE_HOUR_PKT}:00`);
  }
  return deadline;
}

/**
 * Working days the person is given: the working days AFTER the start day up to the deadline day, both ends of that range
 * included. The start day itself is never counted, so a task started on a weekend or a holiday gets the same count as the
 * suggested deadline (which also counts days after the start).
 */
export function givenWorkingDays(start: Date, deadline: Date, holidays: DaySet = []): number {
  return workingDaysBetween(addDays(pakistanDay(start), 1), pakistanDay(deadline), holidays);
}

/** The longest a task may run: its deadline is at most this many days after its start (two years). */
export const MAX_DEADLINE_SPAN_DAYS = 731;

export interface DeadlineCheckInput {
  start: Date;
  deadline: Date;
  now: Date;
  size: TaskSizeName;
  /** The size table's suggested working days (null = XL, must be split). */
  neededDays: number | null;
  holidays?: DaySet;
  /** A personal to-do: only the date checks apply (it is never scored, so its size is not checked). */
  personal?: boolean;
}

/**
 * Errors always refuse the task (a deadline in the past, a deadline before the start, XL). Warnings are soft: the person
 * must confirm them ("An M task usually needs 3 working days; you set 1. Continue?").
 */
export function checkDeadline(input: DeadlineCheckInput): { errors: TaskIssue[]; warnings: TaskIssue[] } {
  const errors: TaskIssue[] = [];
  const warnings: TaskIssue[] = [];
  const { start, deadline, now, size, neededDays, personal } = input;
  const holidays = input.holidays ?? [];

  if (Number.isNaN(deadline.getTime())) return { errors: [{ code: 'deadline_required', message: 'A deadline is required.' }], warnings };
  if (deadline.getTime() < now.getTime()) errors.push({ code: 'deadline_in_past', message: "A deadline can't be in the past." });
  if (deadline.getTime() < start.getTime()) errors.push({ code: 'deadline_before_start', message: 'The deadline cannot be before the start date.' });
  if (deadline.getTime() - start.getTime() > MAX_DEADLINE_SPAN_DAYS * DAY_MS) errors.push({ code: 'deadline_too_far', message: 'A deadline can be at most two years after the start date.' });
  if (personal) return { errors, warnings };

  if (size === 'XL' || neededDays === null) {
    errors.push({ code: 'size_xl_not_assignable', message: 'XL tasks must be split into smaller tasks before they are assigned.' });
    return { errors, warnings };
  }
  if (errors.length === 0 && neededDays > 0) {
    const given = givenWorkingDays(start, deadline, holidays);
    if (given < neededDays) {
      warnings.push({
        code: 'deadline_too_short',
        // Every size is said with a vowel sound (an X-S, an S, an M, an L): "An M task usually needs 3 working days".
        message: `An ${size} task usually needs ${neededDays} working day${neededDays === 1 ? '' : 's'}; you set ${given}. Continue?`,
        details: { size, neededDays, givenDays: given },
      });
    }
  }
  return { errors, warnings };
}

/** A task is on time when it is handed in at or before the approved (current) deadline. */
export function isOnTime(submittedAt: Date, approvedDeadline: Date): boolean {
  return submittedAt.getTime() <= approvedDeadline.getTime();
}

/**
 * The deadline a task's timeliness is measured against (plan section 9: "An extension approved before the deadline is not
 * late", "a request made after the deadline counts as late"). An extension asked for BEFORE the deadline moves the deadline, and
 * the task is judged against the new one. An extension asked for AFTER the deadline (`late`) and approved still moves the
 * deadline the task is worked to, but it must not turn a task that was already late into an on-time one: the task is judged
 * against the deadline that was in force when the first such request was made. `lateRequestDeadlines` = the `currentDeadline`
 * of every APPROVED late extension of the task (empty when there is none).
 */
export function timelinessDeadline(currentDeadline: Date, lateRequestDeadlines: readonly Date[]): Date {
  return lateRequestDeadlines.reduce((earliest, d) => (d.getTime() < earliest.getTime() ? d : earliest), currentDeadline);
}

/** The statuses in which the person doing the task may ask for more time. */
const EXTENSION_STATUSES: ReadonlySet<string> = new Set(['assigned', 'in_progress', 'rework', 'on_hold']);
export const canRequestExtensionIn = (status: string): boolean => EXTENSION_STATUSES.has(status);

/**
 * An extension asks for MORE time. A request made before the deadline is on time; one made after it counts as late
 * ("Request extension (counts as late)"). Returns the errors and whether it is late.
 */
export function checkExtension(input: { currentDeadline: Date; requestedDeadline: Date; now: Date }): { errors: TaskIssue[]; late: boolean } {
  const errors: TaskIssue[] = [];
  const { currentDeadline, requestedDeadline, now } = input;
  if (Number.isNaN(requestedDeadline.getTime())) errors.push({ code: 'deadline_required', message: 'Choose the new deadline.' });
  else if (requestedDeadline.getTime() <= currentDeadline.getTime()) errors.push({ code: 'extension_not_later', message: 'The new deadline must be after the current one.' });
  else if (requestedDeadline.getTime() <= now.getTime()) errors.push({ code: 'deadline_in_past', message: "A deadline can't be in the past." });
  return { errors, late: now.getTime() > currentDeadline.getTime() };
}

/** A manager moving a deadline (earlier or later): it must be a real change, in the future, with a reason. */
export function checkDeadlineChange(input: { current: Date; next: Date; now: Date; reason: string | undefined | null }): TaskIssue[] {
  const errors: TaskIssue[] = [];
  const { current, next, now, reason } = input;
  if (!reason || reason.trim().length < 3) errors.push({ code: 'reason_required', message: 'A reason is required to change the deadline.' });
  if (Number.isNaN(next.getTime())) errors.push({ code: 'deadline_required', message: 'A deadline is required.' });
  else if (next.getTime() === current.getTime()) errors.push({ code: 'deadline_unchanged', message: 'That is already the deadline.' });
  else if (next.getTime() < now.getTime()) errors.push({ code: 'deadline_in_past', message: "A deadline can't be in the past." });
  return errors;
}
