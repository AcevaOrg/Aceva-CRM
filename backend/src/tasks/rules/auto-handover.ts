/**
 * Leaver hand-over (plan section 7: "open tasks move to the manager"). Pure functions: what happens to one task or one
 * repeating series when its owner leaves and the manager takes over.
 *
 * A task only moves to a new owner who sits BELOW the person who assigned it, so the assigner stays above the work: he can
 * still review it, and nobody ends up with a task assigned by someone below them. Otherwise it is closed instead: nobody
 * reviews their own task (the manager assigned it himself), the new owner is above or beside the assigner (the leaver's
 * own manager had left too, so the work would climb the line), or nobody could review it for the new owner. The CEO /
 * Founder / Owner is view-only and never owns work, so a task that would land on him is closed too.
 */

/** The history line of a task that moved. */
export const HANDOVER_MOVED_REASON = 'Employee left';
/** The history line of a task that was closed because the assigner takes over. */
export const HANDOVER_CLOSED_ASSIGNER = 'Closed on hand-over: the assigner takes over';
/** The history line of a task that was closed because the new owner only has view access. */
export const HANDOVER_CLOSED_VIEW_ONLY = 'Closed on hand-over: the new owner only has view access';
/** The history line of a task that was closed because the new owner is not below the person who assigned it. */
export const HANDOVER_CLOSED_NOT_BELOW = 'Closed on hand-over: the new owner is not below the person who assigned it';
/** The history line of a task that was closed because nobody could review it for the new owner. */
export const HANDOVER_CLOSED_NO_REVIEWER = 'Closed on hand-over: nobody could review it for the new owner';

/** The role key of the CEO / Founder / Owner. */
export const OWNER_ROLE_KEY = 'owner';

export interface HandoverTarget {
  /** Internal employee id of the person who takes over. */
  id: string;
  roleKey: string;
}

export type HandoverOutcome = { outcome: 'move' } | { outcome: 'close'; reason: string } | { outcome: 'keep' };

/**
 * What the server found out about the new owner and the person who assigned the work (both default to true when it was not
 * asked, as in the plain unit tests of the other rules).
 */
export interface HandoverFit {
  /** The new owner sits strictly below the person who assigned the work (ScopeService 'below'). */
  belowAssigner?: boolean;
  /**
   * Somebody could ever review the work for the new owner (TaskWorkflowService.standingReviewerIfDoneBy is not null). It
   * does not look at who is away today: an absence ends, a hand-over does not.
   */
  hasReviewer?: boolean;
}

/** Why the new owner cannot take this work, or null when he can. */
function whyNotTaken(task: { assignedById: string }, newOwner: HandoverTarget, fit: HandoverFit): string | null {
  if (newOwner.roleKey === OWNER_ROLE_KEY) return HANDOVER_CLOSED_VIEW_ONLY;
  if (task.assignedById === newOwner.id) return HANDOVER_CLOSED_ASSIGNER;
  if (fit.belowAssigner === false) return HANDOVER_CLOSED_NOT_BELOW;
  if (fit.hasReviewer === false) return HANDOVER_CLOSED_NO_REVIEWER;
  return null;
}

/**
 * What happens to one open work task (`assignedById` is the internal id of the person who assigned it). A task that is
 * already handed in and waiting for its reviewer is finished work: when the manager could not take it it is KEPT with the
 * person who did it (the reviewer approves it as usual) instead of being closed and lost.
 */
export function handoverOutcome(task: { assignedById: string; status?: string }, newOwner: HandoverTarget, fit: HandoverFit = {}): HandoverOutcome {
  const cannotTake = whyNotTaken(task, newOwner, fit);
  if (!cannotTake) return { outcome: 'move' };
  if (task.status === 'submitted' || task.status === 'under_review') return { outcome: 'keep' };
  return { outcome: 'close', reason: cannotTake };
}

/** What happens to a repeating series: it moves, or it stops when the new owner could not take its tasks. */
export function seriesHandoverOutcome(rule: { assignedById: string }, newOwner: HandoverTarget, fit: HandoverFit = {}): 'move' | 'stop' {
  return handoverOutcome(rule, newOwner, fit).outcome === 'move' ? 'move' : 'stop';
}

/** The manager who takes over: the person named in the event, or the nearest manager above them who has not left. */
export function pickHandoverTarget<T extends { status: string }>(named: T, managersAbove: readonly T[]): T | null {
  if (named.status !== 'left') return named;
  return managersAbove.find((m) => m.status !== 'left') ?? null;
}
