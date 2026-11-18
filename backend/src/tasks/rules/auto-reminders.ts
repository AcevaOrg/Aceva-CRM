/**
 * The automation side of the task reminders (plan section 9). Pure functions: job keys, how late a reminder may still go
 * out, and who receives it. The timing itself (when each reminder is due, when it still applies) is in task-reminders.ts.
 *
 * Why the daily overdue notice has a key per day: the job runner marks a job "succeeded" when its handler returns, so a
 * handler that re-armed its OWN row (same dedupe key) would have the new time wiped by that update. Every overdue notice
 * is therefore its own job (key ...:overdue:<Pakistan day>) and the handler arms the NEXT day's, a different row. The
 * other three kinds are armed from outside the handler (when the task is created or changed) and keep one key each.
 */
import { pakistanDay } from '../../activity/rules/activity-time';
import { reminderRecipients, taskReminderKey, taskRepeatKey, type ReminderKind } from './task-reminders';

const HOUR = 3_600_000;

/** A reminder that runs this long after its time is not sent (a server that was down; retries come back sooner than this). */
export const LATE_TOLERANCE_MS = 2 * HOUR;
/** A daily overdue notice that runs this long late is dropped: the next day's notice is due about then anyway. */
export const OVERDUE_LATE_TOLERANCE_MS = 20 * HOUR;

/** The dedupe key of one armed reminder. Overdue notices carry the Pakistan day they are due. */
export function reminderJobKey(taskId: string, kind: ReminderKind, at: Date): string {
  return kind === 'overdue' ? `${taskReminderKey(taskId, kind)}:${pakistanDay(at)}` : taskReminderKey(taskId, kind);
}

/** Every job key of one kind of one task starts with this (the daily overdue keys included). */
export const reminderKindPrefix = (taskId: string, kind: ReminderKind): string => taskReminderKey(taskId, kind);

/** The job of a repeating series for one occurrence day (one row per day, see the note at the top). */
export const repeatJobKey = (ruleId: string, day: string): string => `${taskRepeatKey(ruleId)}:${day}`;
/** Every pending job of a series starts with this. */
export const repeatKeyPrefix = (ruleId: string): string => `${taskRepeatKey(ruleId)}:`;

/** True when the job runs so long after its planned time that the reminder would mislead ("due in 24 hours" after the deadline). */
export function isTooLate(kind: ReminderKind, plannedAt: Date, now: Date): boolean {
  const late = now.getTime() - plannedAt.getTime();
  return late > (kind === 'overdue' ? OVERDUE_LATE_TOLERANCE_MS : LATE_TOLERANCE_MS);
}

export interface ReminderPerson {
  empId: string;
  /** Has left the company: gets no mail. */
  left: boolean;
}

/**
 * Who gets the reminder. Everyone gets it at the person doing the task; the overdue notice also goes to the person who
 * assigned it and to the assignee's manager (the plan says "the employee and their manager"; the assigner is usually that
 * manager, and the same person is never named twice). People who left are dropped. `manager` is the assignee's nearest
 * manager who has not left, or null.
 */
export function resolveReminderRecipients(kind: ReminderKind, assignee: ReminderPerson, assigner: ReminderPerson, manager: ReminderPerson | null): string[] {
  const wanted = reminderRecipients(kind, assignee.empId, assigner.empId);
  if (kind === 'overdue' && manager) wanted.push(manager.empId);
  const left = new Set([assignee, assigner, ...(manager ? [manager] : [])].filter((p) => p.left).map((p) => p.empId));
  return [...new Set(wanted)].filter((empId) => !left.has(empId));
}
