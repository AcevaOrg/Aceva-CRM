/**
 * Who reviews a scorecard and who decides a rating dispute (plan section 10, final company structure). Pure functions:
 * the services load the people (PerformanceDirectory) and ask these. The same rules as `scorecardReviewer` and
 * `disputeDecider` in frontend/src/features/performance/api.ts and logic.ts.
 *
 *  - Reviewer of a scorecard = the nearest person above who is still with the company and reviews work (task.review): the
 *    manager, or one level further up when the manager has left or does not review work (the same walk-up as the task
 *    reviewer in Module 5): CTO -> Development and SQA; Director -> CTO, Sales and Finance. The Director's manager is the
 *    CEO / Founder / Owner, who reviews nothing: the Director's scorecard has NO reviewer and is released by the system when
 *    it is made (the Owner views it). Only a person whose whole line above reviews no work has no reviewer, so a scorecard
 *    is never released without a look when somebody above could have given one.
 *  - Decider of a dispute = the person above the one who gave the rating (the task's reviewer) who reviews work and is not
 *    the employee. A rating the Director gave is looked at again by the Director (nobody above reviews work); the CEO /
 *    Founder / Owner decides nothing.
 */

export interface PersonFacts {
  empId: string;
  /** Emp-ID of the manager; null for the CEO / Founder / Owner. */
  reportsTo: string | null;
  /** Has left the company. */
  left: boolean;
  /** Holds the task.review permission (the Director and the CTO). */
  reviewsWork: boolean;
}

const canReview = (p: PersonFacts | undefined): p is PersonFacts => !!p && !p.left && p.reviewsWork;

/** The chain above a person, nearest first: [manager, manager's manager, ...]. Stops at a loop or a missing manager. */
export function chainAbove(empId: string, people: readonly PersonFacts[]): PersonFacts[] {
  const byId = new Map(people.map((p) => [p.empId, p]));
  const out: PersonFacts[] = [];
  const seen = new Set<string>([empId]);
  let cur = byId.get(empId);
  while (cur?.reportsTo && !seen.has(cur.reportsTo)) {
    const boss = byId.get(cur.reportsTo);
    if (!boss) break;
    out.push(boss);
    seen.add(boss.empId);
    cur = boss;
  }
  return out;
}

/**
 * The person who reviews and releases this person's scorecard: the nearest person above who is still with the company and
 * reviews work. That is the manager in the final structure; when the manager has left, or is active but does not hold
 * task.review (the Director may put someone under any seat), the search goes on up the line. Null = nobody above reviews work
 * (the Director's case): the system releases the scorecard. A person is never their own reviewer (chainAbove leaves them out).
 */
export function scorecardReviewer(empId: string, people: readonly PersonFacts[]): PersonFacts | null {
  return chainAbove(empId, people).find(canReview) ?? null;
}

/**
 * Who decides a dispute about a rating `ratedBy` gave to a task of `employee`: the nearest person above `ratedBy` who reviews
 * work and is not the employee; when nobody is above who reviews work (the Director rated it), `ratedBy` decides again.
 * Null when the only possible decider would be the employee, or nobody (a dispute cannot be decided by its own raiser).
 */
export function disputeDecider(input: { ratedBy: string | null; employee: string }, people: readonly PersonFacts[]): string | null {
  if (!input.ratedBy) return null;
  const above = chainAbove(input.ratedBy, people).find((p) => p.empId !== input.employee && canReview(p));
  const decider = above?.empId ?? input.ratedBy;
  return decider === input.employee ? null : decider;
}
