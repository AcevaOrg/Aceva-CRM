/**
 * The words and the input rules of the "scorecard" and "dispute" items in the approvals inbox. Same texts as
 * frontend/src/features/performance/approvals.ts. Pure functions: no Nest, no database.
 *
 *  - scorecard: approve = release (the reason, when given, is the remark that goes with it); reject = add a remark and keep the
 *    draft (the reason IS the remark, so it is required).
 *  - dispute: approve = change the rating (a new rating 1 to 5 is required); reject = keep the rating. The reason is the decision text.
 */
import { monthLabel } from './perf-month';
import { BAND_LABEL, type Band, type ScorecardKind } from './perf-score';

/** "October 2026 scorecard · 86 (Excellent)"; without a score: "October 2026 scorecard · no score yet". */
export function scorecardItemTitle(month: string, score: number | null, band: Band | null): string {
  const result = score === null || band === null ? 'no score yet' : `${Math.round(score)} (${BAND_LABEL[band]})`;
  return `${monthLabel(month)} scorecard · ${result}`;
}

/** "Rana Ali · 12 tasks · small sample. Review and release; you can add a remark but not change the numbers." */
export function scorecardItemSubtitle(input: { name: string; kind: ScorecardKind; taskCount: number; smallSample: boolean }): string {
  const what = input.kind === 'sales' ? 'sales weights' : `${input.taskCount} tasks`;
  return `${input.name} · ${what}${input.smallSample ? ' · small sample' : ''}. Review and release; you can add a remark but not change the numbers.`;
}

/** "Rating dispute: Fix the login bug (3★)". */
export const disputeItemTitle = (taskTitle: string, currentRating: number): string => `Rating dispute: ${taskTitle} (${currentRating}★)`;

/** The employee's reason in quotes. */
export const disputeItemSubtitle = (reason: string): string => `“${reason}”`;

export const DEFAULT_CHANGE_TEXT = 'Rating changed after review.';
export const DEFAULT_KEEP_TEXT = 'Rating kept.';

export interface ApprovalInput {
  reason?: string;
  rating?: number;
}

export type ApprovalPlan =
  | { ok: true; action: 'release'; remark?: string }
  | { ok: true; action: 'remark'; remark: string }
  | { ok: true; action: 'change_rating'; decision: string; newRating: number }
  | { ok: true; action: 'keep_rating'; decision: string }
  | { ok: false; code: 'reason_required' | 'rating_required'; message: string };

/** What a decision in the inbox means for each item type (the services then apply the usual rules and answer 403 / 409 / 400). */
export function planApproval(type: 'scorecard' | 'dispute', decision: 'approve' | 'reject', input: ApprovalInput): ApprovalPlan {
  const reason = input.reason?.trim() || undefined;
  if (type === 'scorecard') {
    if (decision === 'approve') return { ok: true, action: 'release', remark: reason };
    if (!reason) return { ok: false, code: 'reason_required', message: 'Write the remark to add (the draft stays a draft).' };
    return { ok: true, action: 'remark', remark: reason };
  }
  if (decision === 'reject') return { ok: true, action: 'keep_rating', decision: reason ?? DEFAULT_KEEP_TEXT };
  if (input.rating === undefined) return { ok: false, code: 'rating_required', message: 'Choose the new rating (1 to 5).' };
  return { ok: true, action: 'change_rating', decision: reason ?? DEFAULT_CHANGE_TEXT, newRating: input.rating };
}
