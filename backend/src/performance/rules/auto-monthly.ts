/**
 * The small decisions of the monthly scorecard job (plan section 10), as pure functions: may this month be run, when is its
 * job due, who still needs a scorecard, which reviewer is mailed. The figures themselves come from the calculator and the
 * schedule helpers from rules/perf-month.ts; the Nest service (scorecard-monthly.service.ts) only does the database work.
 */
import { isMonth, monthOf, scorecardRunAt } from './perf-month';

/** A month ("2026-10") may be run once it has started: the job runs for the month that just closed, and a person may run the current month by hand. Never a future month. */
export function checkRunnable(month: string, now: Date): { ok: true } | { ok: false; message: string } {
  if (!isMonth(month)) return { ok: false, message: `"${month}" is not a month (expected 2026-10)` };
  if (month > monthOf(now)) return { ok: false, message: `The month ${month} has not started yet` };
  return { ok: true };
}

/**
 * When the job of `month` should first run: 00:10 Pakistan time on the 1st of the next month, or right away when that moment has
 * already passed (a server that was down on the 1st catches up when it starts). For the current month this is the future moment.
 */
export function ensureRunAt(month: string, now: Date): Date {
  const due = scorecardRunAt(month);
  return due.getTime() > now.getTime() ? due : now;
}

/** Splits the people who should get a scorecard into those still to do and those who already have one (a re-run leaves those alone). */
export function splitExisting<T extends { id: string }>(people: readonly T[], haveScorecard: ReadonlySet<string>): { todo: T[]; existing: T[] } {
  const todo: T[] = [];
  const existing: T[] = [];
  for (const p of people) (haveScorecard.has(p.id) ? existing : todo).push(p);
  return { todo, existing };
}

export interface ReviewerDigest {
  /** The reviewer's Emp-ID. */
  reviewer: string;
  /** How many drafts wait for them. */
  count: number;
  /** The Emp-IDs of the people the drafts are about (sorted). */
  employees: string[];
}

/**
 * One entry per reviewer, for the "drafts are waiting" mail: the drafts grouped by who reviews them now (`reviewerOf` gives the
 * Emp-ID, or null when nobody does, and those are not mailed). `only` limits the result to some reviewers (the ones who got new
 * drafts in this run). Sorted by reviewer Emp-ID. Never one entry per scorecard.
 */
export function groupByReviewer(drafts: ReadonlyArray<{ empId: string }>, reviewerOf: (empId: string) => string | null, only?: ReadonlySet<string>): ReviewerDigest[] {
  const groups = new Map<string, string[]>();
  for (const d of drafts) {
    const reviewer = reviewerOf(d.empId);
    if (!reviewer || (only && !only.has(reviewer))) continue;
    const list = groups.get(reviewer);
    if (list) list.push(d.empId);
    else groups.set(reviewer, [d.empId]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reviewer, employees]) => ({ reviewer, count: employees.length, employees: employees.sort() }));
}

export interface RunCounts {
  month: string;
  created: number;
  existing: number;
  autoReleased: number;
  failed: number;
}

/** The one line the job writes to the server log. */
export const runSummary = (r: RunCounts): string => `Scorecards for ${r.month}: ${r.created} made (${r.autoReleased} released by the system), ${r.existing} already there, ${r.failed} failed`;

/** What the job throws when some people could not get their scorecard: the job runner then retries, and the retry skips everyone already done. */
export const failureMessage = (r: RunCounts): string => `${r.failed} scorecard${r.failed === 1 ? '' : 's'} of ${r.month} could not be made (${r.created} were); the job will be retried`;
