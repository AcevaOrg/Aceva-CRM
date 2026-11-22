/**
 * The task and sales metrics of a month (plan section 10 "The metrics" and "Fairness rules"). Pure functions: no Nest, no
 * database. The same rules as frontend/src/features/performance/logic.ts (taskMetrics, salesMetrics), written for the server.
 *
 *  - Cancelled tasks do not count. Nobody gets credit or blame for work the manager cancelled.
 *  - On time (T) = tasks submitted by their approved deadline / tasks submitted. It is measured at the moment of
 *    submission against the deadline in force (the current, approved one), so an extension approved before the deadline
 *    is not late. An extension asked for after the deadline counts as late: it does not turn a late task into an on-time one.
 *  - A task still waiting for review when the month is measured counts as submitted (T, R) and in the Completion
 *    denominator, but has no rating and earns no approved points: the monthly scorecard is a snapshot taken once.
 *  - Quality (Q) = average reviewer rating weighted by task points, 5 stars = 100.
 *  - Completion (C) = points of approved tasks / points of the tasks due in the month.
 *  - Rework (R) = tasks sent back / tasks submitted (lower is better).
 */
import type { TaskSizeName, TaskStatusName } from '@aceva/contracts';
import { timelinessDeadline } from '../../tasks/rules/task-deadlines';
import { round1 } from './perf-score';

/** How a task stood when it was measured: approved, handed in and waiting, still open (also held or in rework), cancelled. */
export type ScorecardTaskStatusName = 'approved' | 'submitted' | 'open' | 'cancelled';

/** One task as the metrics see it (and as the scorecard stores it). */
export interface ScorecardTaskFacts {
  taskId: string;
  number: string;
  title: string;
  size: TaskSizeName;
  points: number;
  /** The reviewer's rating 1 to 5 (the approved one); null while none. */
  rating: number | null;
  /** Submitted by the approved deadline. */
  onTime: boolean;
  /** Sent back at least once. */
  reworked: boolean;
  extensions: number;
  status: ScorecardTaskStatusName;
  deadline: Date;
}

/** What the services load about a task (columns of the tasks table and the approved rating). */
export interface TaskRowFacts {
  taskId: string;
  number: string;
  title: string;
  size: TaskSizeName;
  points: number;
  status: TaskStatusName;
  deadline: Date;
  /** The last time it was handed in for review. */
  submittedAt: Date | null;
  reworkCount: number;
  extensionsCount: number;
  /**
   * The deadline in force when each APPROVED extension that was asked for AFTER the deadline (task_extensions.late) was
   * requested. Empty or missing = no late extension. A late request counts as late (plan section 9): it must not turn a task
   * that was already late into an on-time one, so timeliness is measured against the earliest of these when there is one.
   */
  lateExtensionDeadlines?: readonly Date[];
  /** The rating of the latest approving review; null when none. */
  rating: number | null;
}

const WAS_SUBMITTED: readonly TaskStatusName[] = ['submitted', 'under_review', 'approved', 'rework'];

/**
 * A task row as the metrics see it. "Reworked" = it was sent back at least once. "On time" = the last hand-in was at or before the
 * deadline in force, where an extension approved before the deadline moves it (not late) and an extension asked for after the
 * deadline does not rescue the task (timelinessDeadline, shared with Module 5); a task never handed in is "on time" only while
 * its deadline has not passed (it is not measured for T anyway).
 */
export function toScorecardTask(row: TaskRowFacts, now: Date): ScorecardTaskFacts {
  const status: ScorecardTaskStatusName =
    row.status === 'approved' ? 'approved' : row.status === 'cancelled' ? 'cancelled' : row.status === 'submitted' || row.status === 'under_review' ? 'submitted' : 'open';
  const measuredDeadline = timelinessDeadline(row.deadline, row.lateExtensionDeadlines ?? []);
  const onTime = row.submittedAt ? row.submittedAt.getTime() <= measuredDeadline.getTime() : WAS_SUBMITTED.includes(row.status) || measuredDeadline.getTime() >= now.getTime();
  return {
    taskId: row.taskId,
    number: row.number,
    title: row.title,
    size: row.size,
    points: row.points,
    rating: row.rating,
    onTime,
    reworked: row.reworkCount > 0,
    extensions: row.extensionsCount,
    status,
    deadline: row.deadline,
  };
}

/**
 * Does this task take part in the metrics now? Not if it was cancelled. A task still open counts only once its deadline has
 * passed or it was already sent back (so a task not yet due, and not started, does not lower anybody's month).
 */
export function countsForMetrics(task: Pick<ScorecardTaskFacts, 'status' | 'deadline' | 'reworked'>, now: Date): boolean {
  if (task.status === 'cancelled') return false;
  return task.status !== 'open' || task.deadline.getTime() <= now.getTime() || task.reworked;
}

export interface MetricTask {
  status: ScorecardTaskStatusName;
  points: number;
  rating: number | null;
  onTime: boolean;
  reworked: boolean;
}

export interface TaskMetricResult {
  /** 0 to 100, one decimal; null when there is nothing to measure. */
  quality: number | null;
  onTime: number | null;
  completion: number | null;
  rework: number | null;
  /** Tasks that were counted (cancelled ones left out). */
  taskCount: number;
}

/** The four task metrics. Pass the tasks that count (see countsForMetrics); cancelled ones are left out here too. */
export function taskMetrics(tasks: readonly MetricTask[]): TaskMetricResult {
  const counted = tasks.filter((t) => t.status !== 'cancelled');
  const approved = counted.filter((t) => t.status === 'approved');
  const rated = approved.filter((t) => t.rating);
  const ratedPoints = rated.reduce((s, t) => s + Math.max(1, t.points), 0);
  const quality = ratedPoints ? (rated.reduce((s, t) => s + (t.rating ?? 0) * Math.max(1, t.points), 0) / ratedPoints) * 20 : null;
  const submitted = counted.filter((t) => t.status === 'approved' || t.status === 'submitted' || t.reworked);
  const onTime = submitted.length ? (submitted.filter((t) => t.onTime).length / submitted.length) * 100 : null;
  const duePoints = counted.reduce((s, t) => s + t.points, 0);
  const completion = duePoints ? (approved.reduce((s, t) => s + t.points, 0) / duePoints) * 100 : null;
  const rework = submitted.length ? (submitted.filter((t) => t.reworked).length / submitted.length) * 100 : null;
  return {
    quality: quality === null ? null : round1(quality),
    onTime: onTime === null ? null : round1(onTime),
    completion: completion === null ? null : round1(completion),
    rework: rework === null ? null : round1(rework),
    taskCount: counted.length,
  };
}

// ---------------------------------------------------------------------------------------------------------- sales

/** The raw sales numbers behind a sales scorecard. They come from Module 15 (the daily sales report and the CRM); never invented. */
export interface SalesDetail {
  targetDaysMet: number;
  workingDays: number;
  meetings: number;
  meetingTarget: number;
  wonValueUsd: number;
  wonTargetUsd: number;
  bounceRate: number;
  duplicates: number;
}

export interface SalesMetricResult {
  activity: number;
  meetings: number;
  won: number;
  dataQuality: number;
  /** Null when attendance could not be measured. */
  attendance: number | null;
}

const clamp100 = (n: number): number => Math.max(0, Math.min(100, n));

/**
 * V = days the daily targets were met / working days. M = meetings / the target (at most 100). W = value won / the sales
 * target (at most 100). D = 100, minus 10 per 1% of bounce rate above 3% and 10 per duplicate lead. A = attendance (null when
 * Module 7 cannot say yet).
 */
export function salesMetrics(d: SalesDetail, attendance: number | null): SalesMetricResult {
  const dq = 100 - Math.max(0, d.bounceRate - 3) * 10 - d.duplicates * 10;
  return {
    activity: round1(d.workingDays ? (d.targetDaysMet / d.workingDays) * 100 : 0),
    meetings: round1(clamp100(d.meetingTarget ? (d.meetings / d.meetingTarget) * 100 : 0)),
    won: round1(clamp100(d.wonTargetUsd ? (d.wonValueUsd / d.wonTargetUsd) * 100 : 0)),
    dataQuality: round1(clamp100(dq)),
    attendance: attendance === null ? null : round1(attendance),
  };
}
