import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANGE_TEXT, DEFAULT_KEEP_TEXT, disputeItemSubtitle, disputeItemTitle, planApproval, scorecardItemSubtitle, scorecardItemTitle } from './core-approvals';

describe('the texts of the inbox items (same as the mock screens)', () => {
  it('scorecard title: month, rounded score and band', () => {
    expect(scorecardItemTitle('2026-10', 85.5, 'excellent')).toBe('October 2026 scorecard · 86 (Excellent)');
    expect(scorecardItemTitle('2026-09', 69.4, 'needs_improvement')).toBe('September 2026 scorecard · 69 (Needs improvement)');
  });
  it('a scorecard without a score says so', () => {
    expect(scorecardItemTitle('2026-10', null, null)).toBe('October 2026 scorecard · no score yet');
  });
  it('scorecard subtitle: task count or sales weights, and the small sample note', () => {
    expect(scorecardItemSubtitle({ name: 'Rana Ali', kind: 'standard', taskCount: 12, smallSample: false })).toBe(
      'Rana Ali · 12 tasks. Review and release; you can add a remark but not change the numbers.',
    );
    expect(scorecardItemSubtitle({ name: 'Rana Ali', kind: 'standard', taskCount: 3, smallSample: true })).toBe(
      'Rana Ali · 3 tasks · small sample. Review and release; you can add a remark but not change the numbers.',
    );
    expect(scorecardItemSubtitle({ name: 'Sara Q', kind: 'sales', taskCount: 20, smallSample: false })).toBe(
      'Sara Q · sales weights. Review and release; you can add a remark but not change the numbers.',
    );
  });
  it('dispute title and subtitle', () => {
    expect(disputeItemTitle('Fix the login bug', 3)).toBe('Rating dispute: Fix the login bug (3★)');
    expect(disputeItemSubtitle('The client approved it')).toBe('“The client approved it”');
  });
});

describe('planApproval: scorecard', () => {
  it('approve releases, with the reason as the remark when given', () => {
    expect(planApproval('scorecard', 'approve', {})).toEqual({ ok: true, action: 'release', remark: undefined });
    expect(planApproval('scorecard', 'approve', { reason: '  Good month  ' })).toEqual({ ok: true, action: 'release', remark: 'Good month' });
  });
  it('reject adds a remark and keeps the draft: the remark is required', () => {
    expect(planApproval('scorecard', 'reject', { reason: 'Check task 3' })).toEqual({ ok: true, action: 'remark', remark: 'Check task 3' });
    expect(planApproval('scorecard', 'reject', {})).toMatchObject({ ok: false, code: 'reason_required' });
    expect(planApproval('scorecard', 'reject', { reason: '   ' })).toMatchObject({ ok: false, code: 'reason_required' });
  });
});

describe('planApproval: dispute', () => {
  it('approve changes the rating: a new rating is required, the reason is the decision text (with a default)', () => {
    expect(planApproval('dispute', 'approve', { rating: 4, reason: 'The spec changed' })).toEqual({ ok: true, action: 'change_rating', decision: 'The spec changed', newRating: 4 });
    expect(planApproval('dispute', 'approve', { rating: 5 })).toEqual({ ok: true, action: 'change_rating', decision: DEFAULT_CHANGE_TEXT, newRating: 5 });
    expect(planApproval('dispute', 'approve', { reason: 'ok' })).toMatchObject({ ok: false, code: 'rating_required' });
  });
  it('reject keeps the rating: no rating needed, the reason is the decision text (with a default)', () => {
    expect(planApproval('dispute', 'reject', { reason: 'The work had bugs' })).toEqual({ ok: true, action: 'keep_rating', decision: 'The work had bugs' });
    expect(planApproval('dispute', 'reject', {})).toEqual({ ok: true, action: 'keep_rating', decision: DEFAULT_KEEP_TEXT });
  });
  it('the default texts are long enough for the decision rule (3 characters)', () => {
    expect(DEFAULT_CHANGE_TEXT.length).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_KEEP_TEXT.length).toBeGreaterThanOrEqual(3);
  });
});
