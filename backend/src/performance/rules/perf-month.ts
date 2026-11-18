/**
 * Months, and which tasks belong to a month (plan section 10). Pure functions: no Nest, no database.
 *
 * A month is "2026-10" and is always a Pakistan month (UTC+5, no daylight saving): it starts at 00:00 on the 1st Pakistan
 * time and ends at 00:00 on the 1st of the next month ([start, end)). The same Pakistan day helpers as the activity module.
 */
import { dayWindow, MINUTE_MS, pakistanDay } from '../../activity/rules/activity-time';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isMonth = (value: string): boolean => MONTH.test(value);

/** "2026-11-17" becomes "2026-11". */
export const monthOfDay = (day: string): string => day.slice(0, 7);

/** The Pakistan month a moment is in. */
export const monthOf = (at: Date): string => monthOfDay(pakistanDay(at));

function shift(month: string, by: number): string {
  const m = MONTH.exec(month);
  if (!m) throw new Error(`Not a month: ${month}`);
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export const previousMonth = (month: string): string => shift(month, -1);
export const nextMonth = (month: string): string => shift(month, 1);

/** The `count` months before `month`, oldest first (for the trend: the last 6 closed months). */
export function monthsBefore(month: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shift(month, -(count - i)));
}

/** The month's first moment (inclusive) and the next month's first moment (exclusive), as UTC instants. */
export function monthWindow(month: string): { start: Date; end: Date } {
  return { start: dayWindow(`${month}-01`).start, end: dayWindow(`${nextMonth(month)}-01`).start };
}

export function inMonth(at: Date, month: string): boolean {
  const { start, end } = monthWindow(month);
  return at.getTime() >= start.getTime() && at.getTime() < end.getTime();
}

/**
 * A task belongs to the month its (approved, current) deadline falls in: "points of tasks due in the month" (plan section
 * 10). A personal to-do never belongs to any month. Each task is counted in exactly one month.
 */
export function taskBelongsToMonth(task: { personal: boolean; deadline: Date }, month: string): boolean {
  return !task.personal && inMonth(task.deadline, month);
}

/** "March 2026" for mails and titles (English month names, no time zone involved). */
export function monthLabel(month: string): string {
  const m = MONTH.exec(month);
  if (!m) return month;
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[Number(m[2]) - 1]} ${m[1]}`;
}

// ---------------------------------------------------------------------------------------------------------- the monthly job

/** The scheduled job that makes the draft scorecards of one month (scheduled_jobs.type). */
export const SCORECARD_JOB = 'scorecard.monthly';
/** The job of a month runs 10 minutes past midnight Pakistan time on the 1st of the NEXT month. */
export const SCORECARD_RUN_DELAY_MS = 10 * MINUTE_MS;

/** One job per month: the dedupe key keeps two servers, or a restart, from making it twice. */
export const scorecardJobKey = (month: string): string => `${SCORECARD_JOB}:${month}`;

/** When the job that scores `month` is due: 00:10 on the 1st of the next month, Pakistan time. */
export const scorecardRunAt = (month: string): Date => new Date(monthWindow(month).end.getTime() + SCORECARD_RUN_DELAY_MS);

/**
 * The months whose job must exist right now: the month that just closed (its job is due on the 1st; after downtime it is
 * made up for when the server starts) and the current month (its job is due on the 1st of next month). Older months are
 * never made up for, so starting the server in the middle of a year does not create a pile of old drafts.
 */
export function monthsToEnsure(now: Date): string[] {
  const current = monthOf(now);
  return [previousMonth(current), current];
}

// ---------------------------------------------------------------------------------------------------------- the trend

export interface ClosedScore {
  month: string;
  score: number | null;
  /** draft | released | acknowledged */
  status: string;
}

export interface TrendEntry {
  month: string;
  score: number;
}

/**
 * The score trend: the last 6 closed months that have a score, then this month's live score. The employee never sees a
 * draft (their manager has not released it yet), so their trend leaves drafts out; people above them see drafts too.
 */
export function buildTrend(closed: readonly ClosedScore[], options: { liveMonth: string; liveScore: number | null; includeDrafts: boolean }): TrendEntry[] {
  const points = closed
    .filter((c) => c.month < options.liveMonth && c.score !== null && (options.includeDrafts || c.status !== 'draft'))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6)
    .map((c) => ({ month: c.month, score: c.score as number }));
  if (options.liveScore !== null) points.push({ month: options.liveMonth, score: options.liveScore });
  return points;
}
