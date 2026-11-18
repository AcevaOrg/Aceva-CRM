/**
 * Who may do what with a scorecard or a dispute (plan section 10). Pure functions: the services work out the facts (is the
 * person the reviewer, does the task have a rating ...) and ask these, then turn a refusal into the right HTTP answer
 * with `kind` (forbidden 403, conflict 409, invalid 400). The texts follow the mock screens.
 *
 *   draft --release (the reviewer)--> released --acknowledge (the employee)--> acknowledged
 *
 *  - Only the reviewer (the person's manager, or the next level up who reviews work when the manager has left or does
 *    not review work) adds a remark and releases. Nobody releases their own.
 *    Nobody, the reviewer included, can change the numbers.
 *  - The employee sees a scorecard only after it is released. People above the employee see drafts too (view only).
 *  - The employee acknowledges a released scorecard, with an optional comment.
 *  - The employee disputes a rated task of their released scorecard; one open dispute per task. The decider (not the
 *    employee, a person who reviews work) upholds the rating or changes it to another rating 1 to 5.
 */
import type { ScorecardKind } from './perf-score';

export type ScorecardStatusName = 'draft' | 'released' | 'acknowledged';
export type DisputeStatusName = 'open' | 'upheld' | 'changed';

export type Refusal = { ok: false; kind: 'forbidden' | 'conflict' | 'invalid'; code: string; message: string };
export type RuleResult = { ok: true } | Refusal;

const ok: RuleResult = { ok: true };
const no = (kind: Refusal['kind'], code: string, message: string): Refusal => ({ ok: false, kind, code, message });

/** Can the viewer see this scorecard at all? The person it is about, only once released; people above them always. */
export function canViewScorecard(input: { isOwner: boolean; isAbove: boolean; status: ScorecardStatusName }): boolean {
  if (input.isOwner) return input.status !== 'draft';
  return input.isAbove;
}

/** A remark can be added while the scorecard is a draft or released (not after the employee acknowledged it). */
export function canAddRemark(input: { isReviewer: boolean; status: ScorecardStatusName }): RuleResult {
  if (!input.isReviewer) return no('forbidden', 'not_reviewer', 'View only. Only the reviewer adds a remark.');
  if (input.status === 'acknowledged') return no('conflict', 'invalid_state', 'The employee already acknowledged this scorecard.');
  return ok;
}

export function canRelease(input: { isReviewer: boolean; isOwn: boolean; status: ScorecardStatusName }): RuleResult {
  if (input.isOwn) return no('forbidden', 'own_scorecard', 'Nobody releases their own scorecard.');
  if (!input.isReviewer) return no('forbidden', 'not_reviewer', "View only. Only the reviewer of this scorecard releases it.");
  if (input.status !== 'draft') return no('conflict', 'invalid_state', 'This scorecard was already released.');
  return ok;
}

export function canAcknowledge(input: { isOwn: boolean; status: ScorecardStatusName }): RuleResult {
  if (!input.isOwn) return no('forbidden', 'not_owner', 'Only the person the scorecard is about acknowledges it.');
  if (input.status === 'draft') return no('conflict', 'invalid_state', 'This scorecard has not been released yet.');
  if (input.status === 'acknowledged') return no('conflict', 'invalid_state', 'You already acknowledged this scorecard.');
  return ok;
}

export interface RaiseDisputeFacts {
  isOwn: boolean;
  status: ScorecardStatusName;
  kind: ScorecardKind;
  /** The task's current rating (the snapshot's, or the one a previous dispute set); null when it has none. */
  rating: number | null;
  /** The task is not on this scorecard. */
  onScorecard: boolean;
  hasOpenDispute: boolean;
  /** Who would decide (Emp-ID); null = nobody can (the scorecard has no reviewer). */
  decider: string | null;
}

export function canRaiseDispute(f: RaiseDisputeFacts): RuleResult {
  if (!f.isOwn) return no('forbidden', 'not_owner', 'You can only dispute a rating on your own scorecard.');
  if (f.status === 'draft') return no('conflict', 'invalid_state', 'Your manager has not released this scorecard yet.');
  if (f.kind !== 'standard') return no('invalid', 'not_rated', 'Only task ratings can be disputed.');
  if (!f.onScorecard || !f.rating) return no('invalid', 'not_rated', 'Choose a rated task.');
  if (f.hasOpenDispute) return no('conflict', 'already_disputed', 'This rating is already disputed.');
  if (!f.decider) return no('invalid', 'no_decider', 'Your scorecard has no reviewer, so there is no one to decide a dispute.');
  return ok;
}

export interface DecideDisputeFacts {
  isDecider: boolean;
  /** The person holds task.review. */
  reviewsWork: boolean;
  isEmployee: boolean;
  status: DisputeStatusName;
}

export function canDecideDispute(f: DecideDisputeFacts): RuleResult {
  if (f.isEmployee) return no('forbidden', 'own_dispute', "You can't decide your own dispute.");
  if (!f.reviewsWork) return no('forbidden', 'not_decider', 'View only. Disputes are decided by the level above the reviewer.');
  if (!f.isDecider) return no('forbidden', 'not_decider', 'This dispute is decided by the level above the reviewer.');
  if (f.status !== 'open') return no('conflict', 'already_decided', 'This dispute was already decided.');
  return ok;
}

export interface DecisionInput {
  change: boolean;
  decision: string;
  newRating?: number;
  /** The rating the task has now. */
  currentRating: number;
}

/** A decision needs a reason; changing the rating needs a new rating from 1 to 5 that differs from the current one. */
export function validateDecision(input: DecisionInput): RuleResult {
  if (input.decision.trim().length < 3) return no('invalid', 'decision_required', 'Please give a reason for your decision (at least 3 characters).');
  if (!input.change) return ok;
  if (input.newRating === undefined) return no('invalid', 'rating_required', 'Choose the new rating (1 to 5).');
  if (!Number.isInteger(input.newRating) || input.newRating < 1 || input.newRating > 5) return no('invalid', 'rating_required', 'The new rating is 1 to 5.');
  if (input.newRating === input.currentRating) return no('invalid', 'rating_unchanged', 'The new rating is the same as the current one. Keep the rating instead.');
  return ok;
}
