/**
 * Task reminders (plan section 9, "Reminders"). Pure functions: when each reminder is due and when it still applies.
 *
 *   half_time    half the time between the start and the deadline has passed and the task has not been started
 *   day_before   24 hours before the deadline (a task still waiting on the person doing it)
 *   deadline     at the deadline
 *   overdue      then a daily notice at 09:00 Pakistan time, to the person and the person who assigned it
 *
 * Reminders are scheduled through the job runner (one job per task and kind, dedupe key taskReminderKey) and re-armed or
 * cancelled when the deadline changes or the task is put on hold, cancelled, submitted or approved. A reminder whose time
 * is already past when the task is (re)scheduled is never back-filled. The job handler asks `stillApplies` again when it
 * runs, so a job that was missed by a cancel can never send a wrong mail. Personal to-dos get no reminders.
 */
import type { TaskStatusName } from '@aceva/contracts';
import { pakistanInstant } from './task-deadlines';
import { pakistanDay } from '../../activity/rules/activity-time';

const HOUR = 3_600_000;

export const REMINDER_KINDS = ['half_time', 'day_before', 'deadline', 'overdue'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const TASK_REMINDER_JOB = 'task.reminder';
export const TASK_REPEAT_JOB = 'task.repeat';
/** The overdue notice goes out at 09:00 Pakistan time. */
export const OVERDUE_HOUR_PKT = '09:00';

export const taskReminderKey = (taskId: string, kind: ReminderKind): string => `${TASK_REMINDER_JOB}:${taskId}:${kind}`;
export const taskRepeatKey = (ruleId: string): string => `${TASK_REPEAT_JOB}:${ruleId}`;
/** Every job key that belongs to one task, for cancelling them all. */
export const taskReminderKeyPrefix = (taskId: string): string => `${TASK_REMINDER_JOB}:${taskId}:`;

/** Statuses in which the task is waiting on the person doing it (their deadline is running). */
const WAITING_ON_PERSON: ReadonlySet<TaskStatusName> = new Set(['assigned', 'in_progress', 'rework']);

/** Does a reminder of this kind still make sense for a task in this status? */
export function kindAppliesTo(kind: ReminderKind, status: TaskStatusName): boolean {
  if (kind === 'half_time') return status === 'assigned';
  return WAITING_ON_PERSON.has(status);
}

export interface ReminderTask {
  status: TaskStatusName;
  personal: boolean;
  startDate: Date;
  deadline: Date;
  /** First time it was started; null while it never was. */
  startedAt: Date | null;
}

/**
 * The reminders to arm for a task now. Kinds that do not apply to the status are left out, and so is any reminder whose
 * time is not in the future (never back-filled); `overdue` is the first daily notice, then the job re-arms itself.
 */
export function reminderSchedule(task: ReminderTask, now: Date): Array<{ kind: ReminderKind; at: Date }> {
  if (task.personal) return [];
  const out: Array<{ kind: ReminderKind; at: Date }> = [];
  const { startDate, deadline } = task;
  const length = deadline.getTime() - startDate.getTime();
  const candidates: Array<{ kind: ReminderKind; at: Date }> = [];
  if (task.startedAt === null && length > 0) candidates.push({ kind: 'half_time', at: new Date(startDate.getTime() + length / 2) });
  const dayBefore = new Date(deadline.getTime() - 24 * HOUR);
  // A task shorter than a day never starts inside its own "24 hours before" window.
  if (dayBefore.getTime() > startDate.getTime()) candidates.push({ kind: 'day_before', at: dayBefore });
  candidates.push({ kind: 'deadline', at: deadline });
  candidates.push({ kind: 'overdue', at: nextOverdueAt(deadline, now) });
  for (const c of candidates) if (kindAppliesTo(c.kind, task.status) && c.at.getTime() > now.getTime()) out.push(c);
  return out;
}

/** The next 09:00 Pakistan time strictly after both `deadline` and `after` (the first daily overdue notice, then each next one). */
export function nextOverdueAt(deadline: Date, after: Date): Date {
  const floor = Math.max(deadline.getTime(), after.getTime());
  let day = pakistanDay(new Date(floor));
  let at = pakistanInstant(day, OVERDUE_HOUR_PKT);
  while (at.getTime() <= floor) {
    day = pakistanDay(new Date(at.getTime() + 24 * HOUR));
    at = pakistanInstant(day, OVERDUE_HOUR_PKT);
  }
  return at;
}

/**
 * Checked again when the job runs: the task is still in a status the reminder applies to, still has the deadline the job
 * was armed for (a changed deadline re-arms the jobs), and the time has come.
 */
export function stillApplies(kind: ReminderKind, task: ReminderTask, armedForDeadline: Date, now: Date): boolean {
  if (task.personal) return false;
  if (!kindAppliesTo(kind, task.status)) return false;
  if (task.deadline.getTime() !== armedForDeadline.getTime()) return false;
  if (kind === 'half_time' && task.startedAt !== null) return false;
  if (kind === 'overdue') return now.getTime() > task.deadline.getTime();
  return true;
}

/** Who gets the mail: the person doing the task, and for an overdue notice also the person who assigned it. */
export function reminderRecipients(kind: ReminderKind, assignee: string, assignedBy: string): string[] {
  const list = kind === 'overdue' ? [assignee, assignedBy] : [assignee];
  return [...new Set(list)];
}
