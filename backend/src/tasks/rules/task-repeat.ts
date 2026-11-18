/**
 * Repeating tasks (plan section 9, "Repeating tasks, such as a weekly report every Monday"). Pure functions.
 *
 * A series repeats weekly on a weekday (1 = Monday ... 7 = Sunday) or monthly on a day 1 to 28 (so the day exists in every
 * month). It ends on its stop date (that day is still created) or when someone stops it. Occurrences are Pakistan days;
 * each new task starts at the start time of day of the task that began the series and runs for the same length.
 */
import { MINUTE_MS, pakistanDay, dayWindow } from '../../activity/rules/activity-time';
import { addDays, isoWeekdayOf, pakistanInstant } from './task-deadlines';

export interface RepeatRule {
  every: 'week' | 'month';
  /** Weekly: 1 to 7. Monthly: 1 to 28. */
  on: number;
  /** The last day (Pakistan day, included). Null/undefined: until stopped. */
  until?: string | null;
}

/** Does the series have a task on this day? (Ignores the stop date.) */
export function occursOn(rule: RepeatRule, day: string): boolean {
  return rule.every === 'week' ? isoWeekdayOf(day) === rule.on : Number(day.slice(8, 10)) === rule.on;
}

/** The first occurrence strictly after `after`, or null when it would fall after the stop date. */
export function nextOccurrence(rule: RepeatRule, after: string): string | null {
  // A month never has more than 31 days between two occurrences; 62 is a safe bound.
  for (let i = 1; i <= 62; i++) {
    const day = addDays(after, i);
    if (rule.until && day > rule.until) return null;
    if (occursOn(rule, day)) return day;
  }
  return null;
}

/**
 * Every occurrence in (lastOccurrenceOn, today], oldest first, at most `limit` of them (the NEWEST ones are kept, so a
 * server that was down for weeks makes the latest task, not a pile of stale ones). The stop date is respected.
 */
export function dueOccurrences(rule: RepeatRule, lastOccurrenceOn: string, today: string, limit = 3): string[] {
  const days: string[] = [];
  for (let day = nextOccurrence(rule, lastOccurrenceOn); day && day <= today; day = nextOccurrence(rule, day)) days.push(day);
  return days.slice(-limit);
}

/** True when the series has nothing more to make after `lastOccurrenceOn` (its stop date has passed). */
export function isFinished(rule: RepeatRule, lastOccurrenceOn: string): boolean {
  return nextOccurrence(rule, lastOccurrenceOn) === null;
}

/** When the job should run to make the task of an occurrence day: five minutes after midnight Pakistan time. */
export function occurrenceRunAt(day: string): Date {
  return new Date(dayWindow(day).start.getTime() + 5 * MINUTE_MS);
}

/** "09:00" (Pakistan time) of an instant. */
export function pakistanTimeOfDay(at: Date): string {
  return new Date(at.getTime() + 5 * 3_600_000).toISOString().slice(11, 16);
}

/** What a series remembers from the task that started it: its start time of day and how long it runs. */
export function templateTiming(startDate: Date, deadline: Date): { startTime: string; durationMinutes: number } {
  return { startTime: pakistanTimeOfDay(startDate), durationMinutes: Math.max(1, Math.round((deadline.getTime() - startDate.getTime()) / MINUTE_MS)) };
}

/** The start and the deadline of the task made for an occurrence day. */
export function occurrenceWindow(day: string, timing: { startTime: string; durationMinutes: number }): { start: Date; deadline: Date } {
  const start = pakistanInstant(day, timing.startTime);
  return { start, deadline: new Date(start.getTime() + timing.durationMinutes * MINUTE_MS) };
}

/** The Pakistan day a task that starts at `start` stands for in its series. */
export const occurrenceDayOf = (start: Date): string => pakistanDay(start);

/** Plain words for the screens and mails: "Every Monday" / "On the 5th of every month (until 31 Dec 2026)". */
export function describeRepeat(rule: RepeatRule): string {
  const names = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const base = rule.every === 'week' ? `Every ${names[rule.on]}` : `On day ${rule.on} of every month`;
  return rule.until ? `${base}, until ${rule.until}` : base;
}
