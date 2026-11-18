/**
 * Workload (plan section 9, "Workload check"): the estimated hours of a person's open tasks against their weekly
 * capacity (40 hours by default, less for part-time staff and interns). Pure functions.
 */
import type { TaskStatusName } from '@aceva/contracts';
import type { TaskIssue } from './task-deadlines';
import { isOpen } from './task-status';

export interface WorkloadTask {
  status: TaskStatusName;
  personal: boolean;
  estimatedHours: number;
}

/** Open work hours: every open task that is scored (a personal to-do never counts). Matches the mock screens. */
export function openHours(tasks: readonly WorkloadTask[]): number {
  return tasks.filter((t) => !t.personal && isOpen(t.status)).reduce((sum, t) => sum + t.estimatedHours, 0);
}

export function openTaskCount(tasks: readonly WorkloadTask[]): number {
  return tasks.filter((t) => !t.personal && isOpen(t.status)).length;
}

export interface WorkloadCheck {
  openHours: number;
  addedHours: number;
  capacity: number;
  after: number;
  over: boolean;
  overBy: number;
}

/** Would adding `addedHours` push the person over their weekly capacity? Exactly at capacity is fine. */
export function workloadAfter(input: { openHours: number; addedHours: number; capacity: number }): WorkloadCheck {
  const after = round1(input.openHours + input.addedHours);
  const over = after > input.capacity;
  return { ...input, after, over, overBy: over ? round1(after - input.capacity) : 0 };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
/** 46 or 46.5 (no trailing zeros). */
export const hoursText = (n: number): string => String(round1(n));

/** The warning shown before assigning ("This puts Ali Raza at 46 h of 40 h this week."), or null when it fits. */
export function workloadWarning(name: string, empId: string, check: WorkloadCheck): TaskIssue | null {
  if (!check.over) return null;
  return {
    code: 'overloaded',
    message: `This puts ${name} at ${hoursText(check.after)} h of ${hoursText(check.capacity)} h this week.`,
    details: { empId, openHours: check.openHours, addedHours: check.addedHours, capacity: check.capacity },
  };
}
