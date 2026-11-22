import { describe, expect, it } from 'vitest';
import { canAcknowledge, canAddRemark, canDecideDispute, canRaiseDispute, canRelease, canViewScorecard, validateDecision } from './perf-actions';
import { chainAbove, disputeDecider, scorecardReviewer, type PersonFacts } from './perf-people';

const p = (empId: string, reportsTo: string | null, extra: Partial<PersonFacts> = {}): PersonFacts => ({ empId, reportsTo, left: false, reviewsWork: false, ...extra });

// The final company structure: Owner -> Director -> CTO -> developers; Director -> Sales and Finance.
const OWNER = p('ACV-0001', null);
const DIRECTOR = p('ACV-0003', 'ACV-0001', { reviewsWork: true });
const CTO = p('ACV-0004', 'ACV-0003', { reviewsWork: true });
const DEV = p('ACV-0006', 'ACV-0004');
const DEV2 = p('ACV-0007', 'ACV-0004');
const SALES = p('ACV-0009', 'ACV-0003');
const FINANCE = p('ACV-0010', 'ACV-0003');
const PEOPLE = [OWNER, DIRECTOR, CTO, DEV, DEV2, SALES, FINANCE];

describe('scorecardReviewer', () => {
  it('Development and SQA: the CTO', () => {
    expect(scorecardReviewer('ACV-0006', PEOPLE)?.empId).toBe('ACV-0004');
  });
  it('the CTO, Sales and Finance: the Director', () => {
    expect(scorecardReviewer('ACV-0004', PEOPLE)?.empId).toBe('ACV-0003');
    expect(scorecardReviewer('ACV-0009', PEOPLE)?.empId).toBe('ACV-0003');
    expect(scorecardReviewer('ACV-0010', PEOPLE)?.empId).toBe('ACV-0003');
  });
  it('the Director has no reviewer: the CEO / Founder / Owner reviews nothing', () => {
    expect(scorecardReviewer('ACV-0003', PEOPLE)).toBeNull();
  });
  it('the CEO / Founder / Owner has no manager and no reviewer', () => {
    expect(scorecardReviewer('ACV-0001', PEOPLE)).toBeNull();
  });
  it('one level further up when the manager has left', () => {
    const people = PEOPLE.map((x) => (x.empId === 'ACV-0004' ? { ...x, left: true } : x));
    expect(scorecardReviewer('ACV-0006', people)?.empId).toBe('ACV-0003');
  });
  it('nobody when the manager left and the next one up reviews nothing', () => {
    const people = PEOPLE.map((x) => (x.empId === 'ACV-0003' ? { ...x, left: true } : x));
    expect(scorecardReviewer('ACV-0009', people)).toBeNull();
    expect(scorecardReviewer('ACV-0004', people)).toBeNull();
  });
  it('one level further up when the manager is here but does not review work: the next level checks every scorecard', () => {
    // The CTO's review right is taken away: the Director above reviews the developer's scorecard.
    expect(scorecardReviewer('ACV-0006', PEOPLE.map((x) => (x.empId === 'ACV-0004' ? { ...x, reviewsWork: false } : x)))?.empId).toBe('ACV-0003');
    // The Director can put an SQA person under Finance (who reviews nothing): the Director still reviews, the system does not release it.
    const underFinance = PEOPLE.map((x) => (x.empId === 'ACV-0007' ? { ...x, reportsTo: 'ACV-0010' } : x));
    expect(scorecardReviewer('ACV-0007', underFinance)?.empId).toBe('ACV-0003');
    // Under a Sales person the same.
    const underSales = PEOPLE.map((x) => (x.empId === 'ACV-0006' ? { ...x, reportsTo: 'ACV-0009' } : x));
    expect(scorecardReviewer('ACV-0006', underSales)?.empId).toBe('ACV-0003');
  });
  it('nobody when nobody in the whole line above reviews work', () => {
    const nobodyReviews = PEOPLE.map((x) => ({ ...x, reviewsWork: false }));
    expect(scorecardReviewer('ACV-0006', nobodyReviews)).toBeNull();
    expect(scorecardReviewer('ACV-0007', PEOPLE.map((x) => (x.empId === 'ACV-0003' ? { ...x, reviewsWork: false } : x.empId === 'ACV-0004' ? { ...x, reviewsWork: false } : x)))).toBeNull();
  });
  it('a person is never their own reviewer, and a loop in the data does not hang', () => {
    const loop = [p('A', 'B', { reviewsWork: true }), p('B', 'A', { reviewsWork: true, left: true })];
    expect(scorecardReviewer('A', loop)).toBeNull();
    expect(scorecardReviewer('missing', PEOPLE)).toBeNull();
  });
});

describe('chainAbove', () => {
  it('lists the managers nearest first', () => {
    expect(chainAbove('ACV-0006', PEOPLE).map((x) => x.empId)).toEqual(['ACV-0004', 'ACV-0003', 'ACV-0001']);
    expect(chainAbove('ACV-0001', PEOPLE)).toEqual([]);
  });
  it('stops at a loop', () => {
    expect(chainAbove('A', [p('A', 'B'), p('B', 'A')]).map((x) => x.empId)).toEqual(['B']);
  });
});

describe('disputeDecider', () => {
  it('a rating the CTO gave a developer: the Director decides', () => {
    expect(disputeDecider({ ratedBy: 'ACV-0004', employee: 'ACV-0006' }, PEOPLE)).toBe('ACV-0003');
  });
  it('a rating the Director gave (Sales, Finance, the CTO): the Director looks at it again; the Owner decides nothing', () => {
    expect(disputeDecider({ ratedBy: 'ACV-0003', employee: 'ACV-0009' }, PEOPLE)).toBe('ACV-0003');
    expect(disputeDecider({ ratedBy: 'ACV-0003', employee: 'ACV-0004' }, PEOPLE)).toBe('ACV-0003');
  });
  it('skips a level that left, or does not review work', () => {
    const people = PEOPLE.map((x) => (x.empId === 'ACV-0003' ? { ...x, left: true } : x));
    // the Director left: above the CTO nobody reviews work, so the CTO (the rater) decides again
    expect(disputeDecider({ ratedBy: 'ACV-0004', employee: 'ACV-0006' }, people)).toBe('ACV-0004');
  });
  it('never the employee', () => {
    // nobody above the Director reviews work and the rater is the employee himself: nobody can decide
    expect(disputeDecider({ ratedBy: 'ACV-0003', employee: 'ACV-0003' }, PEOPLE)).toBeNull();
  });
  it('nobody when nobody gave the rating', () => {
    expect(disputeDecider({ ratedBy: null, employee: 'ACV-0006' }, PEOPLE)).toBeNull();
  });
});

describe('who sees a scorecard', () => {
  it('the employee only after release; people above always', () => {
    expect(canViewScorecard({ isOwner: true, isAbove: false, status: 'draft' })).toBe(false);
    expect(canViewScorecard({ isOwner: true, isAbove: false, status: 'released' })).toBe(true);
    expect(canViewScorecard({ isOwner: true, isAbove: false, status: 'acknowledged' })).toBe(true);
    expect(canViewScorecard({ isOwner: false, isAbove: true, status: 'draft' })).toBe(true);
  });
  it('nobody else (beside or below, or the CTO for Sales)', () => {
    expect(canViewScorecard({ isOwner: false, isAbove: false, status: 'released' })).toBe(false);
  });
});

describe('remark and release', () => {
  it('only the reviewer adds a remark, not after the employee acknowledged', () => {
    expect(canAddRemark({ isReviewer: true, status: 'draft' })).toEqual({ ok: true });
    expect(canAddRemark({ isReviewer: true, status: 'released' })).toEqual({ ok: true });
    expect(canAddRemark({ isReviewer: false, status: 'draft' })).toMatchObject({ ok: false, kind: 'forbidden', code: 'not_reviewer' });
    expect(canAddRemark({ isReviewer: true, status: 'acknowledged' })).toMatchObject({ ok: false, kind: 'conflict' });
  });
  it('only the reviewer releases, a draft once, never their own', () => {
    expect(canRelease({ isReviewer: true, isOwn: false, status: 'draft' })).toEqual({ ok: true });
    expect(canRelease({ isReviewer: false, isOwn: false, status: 'draft' })).toMatchObject({ ok: false, kind: 'forbidden', code: 'not_reviewer' });
    expect(canRelease({ isReviewer: true, isOwn: true, status: 'draft' })).toMatchObject({ ok: false, kind: 'forbidden', code: 'own_scorecard' });
    expect(canRelease({ isReviewer: true, isOwn: false, status: 'released' })).toMatchObject({ ok: false, kind: 'conflict', code: 'invalid_state' });
  });
});

describe('acknowledge', () => {
  it('the employee acknowledges a released scorecard once', () => {
    expect(canAcknowledge({ isOwn: true, status: 'released' })).toEqual({ ok: true });
    expect(canAcknowledge({ isOwn: true, status: 'draft' })).toMatchObject({ ok: false, kind: 'conflict' });
    expect(canAcknowledge({ isOwn: true, status: 'acknowledged' })).toMatchObject({ ok: false, kind: 'conflict' });
    expect(canAcknowledge({ isOwn: false, status: 'released' })).toMatchObject({ ok: false, kind: 'forbidden' });
  });
});

describe('raising a dispute', () => {
  const ok = { isOwn: true, status: 'released' as const, kind: 'standard' as const, rating: 3, onScorecard: true, hasOpenDispute: false, decider: 'ACV-0003' };
  it('is allowed on a rated task of the own released scorecard', () => {
    expect(canRaiseDispute(ok)).toEqual({ ok: true });
    expect(canRaiseDispute({ ...ok, status: 'acknowledged' })).toEqual({ ok: true });
  });
  it('is refused for someone else, a draft, a task without a rating, a task not on the scorecard', () => {
    expect(canRaiseDispute({ ...ok, isOwn: false })).toMatchObject({ ok: false, kind: 'forbidden' });
    expect(canRaiseDispute({ ...ok, status: 'draft' })).toMatchObject({ ok: false, kind: 'conflict' });
    expect(canRaiseDispute({ ...ok, rating: null })).toMatchObject({ ok: false, code: 'not_rated' });
    expect(canRaiseDispute({ ...ok, onScorecard: false })).toMatchObject({ ok: false, code: 'not_rated' });
    expect(canRaiseDispute({ ...ok, kind: 'sales' })).toMatchObject({ ok: false, code: 'not_rated' });
  });
  it('one open dispute per task', () => {
    expect(canRaiseDispute({ ...ok, hasOpenDispute: true })).toMatchObject({ ok: false, kind: 'conflict', code: 'already_disputed', message: 'This rating is already disputed.' });
  });
  it('is refused when nobody could decide (the scorecard has no reviewer)', () => {
    expect(canRaiseDispute({ ...ok, decider: null })).toMatchObject({ ok: false, code: 'no_decider' });
  });
});

describe('deciding a dispute', () => {
  const ok = { isDecider: true, reviewsWork: true, isEmployee: false, status: 'open' as const };
  it('the decider decides an open dispute', () => {
    expect(canDecideDispute(ok)).toEqual({ ok: true });
  });
  it('nobody decides their own dispute, only people who review work decide, only the decider, only once', () => {
    expect(canDecideDispute({ ...ok, isEmployee: true })).toMatchObject({ ok: false, code: 'own_dispute' });
    expect(canDecideDispute({ ...ok, reviewsWork: false })).toMatchObject({ ok: false, kind: 'forbidden' });
    expect(canDecideDispute({ ...ok, isDecider: false })).toMatchObject({ ok: false, kind: 'forbidden' });
    expect(canDecideDispute({ ...ok, status: 'upheld' })).toMatchObject({ ok: false, kind: 'conflict', code: 'already_decided' });
  });
  it('a decision needs a reason; a change needs a different rating 1 to 5', () => {
    expect(validateDecision({ change: false, decision: 'Rating kept.', currentRating: 3 })).toEqual({ ok: true });
    expect(validateDecision({ change: false, decision: ' ', currentRating: 3 })).toMatchObject({ ok: false, code: 'decision_required' });
    expect(validateDecision({ change: true, decision: 'Fair point.', newRating: 4, currentRating: 3 })).toEqual({ ok: true });
    expect(validateDecision({ change: true, decision: 'Fair point.', currentRating: 3 })).toMatchObject({ ok: false, code: 'rating_required' });
    expect(validateDecision({ change: true, decision: 'Fair point.', newRating: 6, currentRating: 3 })).toMatchObject({ ok: false, code: 'rating_required' });
    expect(validateDecision({ change: true, decision: 'Fair point.', newRating: 3, currentRating: 3 })).toMatchObject({ ok: false, code: 'rating_unchanged' });
  });
});
