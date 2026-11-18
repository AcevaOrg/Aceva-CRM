/**
 * The task status machine (plan section 9, "Task statuses"). Pure functions: no Nest, no database.
 *
 *   assigned -> in_progress -> submitted -> under_review -> approved
 *                    ^             |             |
 *                    '---- rework <--------------'     (rework: the person fixes it and submits again)
 *   on hold and cancelled: by the assigner, with a reason. Resume puts an on-hold task back to in progress.
 *   "Overdue" is a flag worked out from the deadline, never a status.
 *
 * Who may do what (final company structure): the person doing the task starts and submits; the reviewer (the assigner,
 * or their stand-in or the next level up) picks it up, approves with a rating or sends it back with a reason; the assigner
 * puts it on hold, resumes or cancels it. Nobody reviews their own task. A personal to-do has no review: the owner starts
 * it, marks it done (no rating, not scored), reopens it or cancels it.
 */
import type { TaskActionName, TaskStatusName } from '@aceva/contracts';

export const OPEN_STATUSES: readonly TaskStatusName[] = ['assigned', 'in_progress', 'submitted', 'under_review', 'rework', 'on_hold'];
export const isOpen = (status: TaskStatusName): boolean => OPEN_STATUSES.includes(status);
/** Handed in and waiting for the reviewer: the deadline no longer counts against the person doing it. */
export const isWaitingOnReviewer = (status: TaskStatusName): boolean => status === 'submitted' || status === 'under_review';
/** Waiting on the reviewer, or finished: the person doing it has nothing left to do. */
export const isSettled = (status: TaskStatusName): boolean => !isOpen(status) || isWaitingOnReviewer(status);

/** What each action turns the status into. */
export const ACTION_TARGET: Readonly<Record<TaskActionName, TaskStatusName>> = {
  start: 'in_progress',
  submit: 'submitted',
  review: 'under_review',
  approve: 'approved',
  rework: 'rework',
  hold: 'on_hold',
  cancel: 'cancelled',
  resume: 'in_progress',
  done: 'approved',
  reopen: 'assigned',
};

/** The actions that need a reason (a reviewer sending it back, or the assigner stopping it). */
export const REASON_REQUIRED: readonly TaskActionName[] = ['rework', 'hold', 'cancel'];

export interface ActionContext {
  status: TaskStatusName;
  personal: boolean;
  /** The person acting is the person doing the task. */
  isAssignee: boolean;
  /** The person acting assigned the task and holds task.assign. */
  isAssigner: boolean;
  /** The person acting is the task's reviewer now and holds task.review. */
  isReviewer: boolean;
}

/** The actions open to this person on this task right now. */
export function allowedActions(ctx: ActionContext): TaskActionName[] {
  const { status, personal, isAssignee } = ctx;
  const out: TaskActionName[] = [];

  if (personal) {
    // The owner is both the person doing it and the assigner.
    if (!isAssignee) return out;
    if (status === 'assigned') out.push('start');
    if (status === 'assigned' || status === 'in_progress') out.push('done');
    if (status === 'approved') out.push('reopen');
    if (status === 'assigned' || status === 'in_progress') out.push('cancel');
    return out;
  }

  switch (status) {
    case 'assigned':
      if (isAssignee) out.push('start');
      break;
    case 'in_progress':
      if (isAssignee) out.push('submit');
      break;
    case 'rework':
      // The mock screens go straight to "submitted"; the plan sends the task back to "in progress". Both are allowed.
      if (isAssignee) out.push('submit', 'start');
      break;
    case 'submitted':
      if (ctx.isReviewer && !isAssignee) out.push('review', 'approve', 'rework');
      break;
    case 'under_review':
      if (ctx.isReviewer && !isAssignee) out.push('approve', 'rework');
      break;
    case 'on_hold':
      if (ctx.isAssigner && !isAssignee) out.push('resume');
      break;
    default:
      break;
  }
  // The assigner may stop any open task, a held one included (but never their own work).
  if (ctx.isAssigner && !isAssignee && isOpen(status)) {
    if (status !== 'on_hold') out.push('hold');
    out.push('cancel');
  }
  return out;
}

export interface ActionInput {
  reason?: string | null;
  rating?: number | null;
}

export type ActionResult =
  | { ok: true; action: TaskActionName; from: TaskStatusName; to: TaskStatusName; effects: ActionEffects }
  | { ok: false; code: 'not_allowed' | 'reason_required' | 'rating_required'; message: string };

/** What else changes on the task row besides the status (the service applies these in the same transaction). */
export interface ActionEffects {
  /** Set started_at (only when the task was never started before). */
  setStartedAt: boolean;
  /** Set submitted_at to now. */
  setSubmittedAt: boolean;
  /** Add one to rework_count. */
  incrementRework: boolean;
  /** Set closed_at to now (approved, done, cancelled). */
  setClosedAt: boolean;
  /** Clear closed_at (reopen). */
  clearClosedAt: boolean;
  /** Write a task_reviews row (approve or rework by a reviewer). */
  writesReview: boolean;
}

/** Checks one action for this person and says what changes. The reasons and the rating are required here, in one place. */
export function evaluateAction(action: TaskActionName, ctx: ActionContext, input: ActionInput = {}, startedAt: Date | null = null): ActionResult {
  if (!allowedActions(ctx).includes(action)) {
    return { ok: false, code: 'not_allowed', message: `You cannot do "${action}" on a task that is ${ctx.status.replace('_', ' ')}.` };
  }
  if (REASON_REQUIRED.includes(action) && !ctx.personal && (input.reason ?? '').trim().length < 3) {
    return { ok: false, code: 'reason_required', message: 'A reason is required.' };
  }
  if (action === 'approve' && !(Number.isInteger(input.rating) && (input.rating as number) >= 1 && (input.rating as number) <= 5)) {
    return { ok: false, code: 'rating_required', message: 'A rating from 1 to 5 is required.' };
  }
  const to = ACTION_TARGET[action];
  return {
    ok: true,
    action,
    from: ctx.status,
    to,
    effects: {
      setStartedAt: to === 'in_progress' && startedAt === null,
      setSubmittedAt: action === 'submit',
      incrementRework: action === 'rework',
      setClosedAt: action === 'approve' || action === 'done' || action === 'cancel',
      clearClosedAt: action === 'reopen',
      writesReview: !ctx.personal && (action === 'approve' || action === 'rework'),
    },
  };
}

/**
 * The overdue flag shown on top of the status (never stored): open, not waiting on the reviewer, and past the deadline.
 * Matches frontend/src/features/tasks/logic.ts computeOverdue.
 */
export function isOverdue(task: { status: TaskStatusName; deadline: Date }, now: Date): boolean {
  return isOpen(task.status) && !isWaitingOnReviewer(task.status) && task.deadline.getTime() < now.getTime();
}
