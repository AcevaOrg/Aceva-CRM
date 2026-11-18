/**
 * Small pure rules of the Module 6 core services: who is shown as the reviewer of a scorecard, the order of the team table,
 * the next weights version number and who may see a dispute. No Nest, no database.
 */
import type { ScorecardStatusName } from './perf-actions';

/**
 * The Emp-ID shown as "reviewer" of a scorecard.
 *  - A DRAFT shows the person who reviews it NOW (the manager, or the next level up when the manager has left or does not review work), so a leaver's
 *    drafts move up. Null when nobody can (the Director's scorecard is never a draft: the system releases it).
 *  - A released or acknowledged scorecard shows who released it, else the reviewer stored when it was made. The Director's
 *    scorecard (released by the system, no reviewer) shows none.
 */
export function reviewerShown(input: { status: ScorecardStatusName; currentReviewer: string | null; storedReviewer: string | null; releasedBy: string | null }): string | null {
  if (input.status === 'draft') return input.currentReviewer;
  return input.releasedBy ?? input.storedReviewer;
}

/**
 * The team table is sorted by name (full name, then Emp-ID), never by score: there is no ranking. Case and accents do not
 * matter ("anna" and "Anna" sit together), and a tie is broken by the Emp-ID so the order is always the same.
 */
export function sortByName<T extends { fullName: string; empId: string }>(people: readonly T[]): T[] {
  return [...people].sort((a, b) => a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' }) || a.empId.localeCompare(b.empId));
}

/** The number of the next version of a set of weights: one more than the highest so far (1 for the first). */
export function nextVersionNo(existing: readonly number[]): number {
  return existing.reduce((highest, n) => Math.max(highest, n), 0) + 1;
}

/**
 * Who may see a dispute: the employee who raised it, the person who must decide it, and everyone above the employee in the
 * reporting line (the CEO / Founder / Owner too, view only).
 */
export function canViewDispute(input: { isEmployee: boolean; isDecider: boolean; isAboveEmployee: boolean }): boolean {
  return input.isEmployee || input.isDecider || input.isAboveEmployee;
}
