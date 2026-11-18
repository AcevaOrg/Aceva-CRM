import { describe, expect, it } from 'vitest';
import type { TaskActionName, TaskStatusName } from '@aceva/contracts';
import { ACTION_TARGET, allowedActions, evaluateAction, isOpen, isOverdue, isSettled, isWaitingOnReviewer, OPEN_STATUSES, type ActionContext } from './task-status';

const ALL: TaskStatusName[] = ['assigned', 'in_progress', 'submitted', 'under_review', 'approved', 'rework', 'on_hold', 'cancelled'];

const ctx = (status: TaskStatusName, who: 'assignee' | 'reviewer' | 'assigner' | 'both' | 'nobody', personal = false): ActionContext => ({
  status,
  personal,
  isAssignee: who === 'assignee',
  isAssigner: who === 'assigner' || who === 'both',
  isReviewer: who === 'reviewer' || who === 'both',
});
const sorted = (a: TaskActionName[]) => [...a].sort();

describe('who may do what on a work task', () => {
  it('the person doing it starts an assigned task and submits one in progress', () => {
    expect(allowedActions(ctx('assigned', 'assignee'))).toEqual(['start']);
    expect(allowedActions(ctx('in_progress', 'assignee'))).toEqual(['submit']);
  });

  it('after a rework the person can submit again (or start it again)', () => {
    expect(sorted(allowedActions(ctx('rework', 'assignee')))).toEqual(['start', 'submit']);
  });

  it('the person doing it can do nothing once it is submitted, approved or cancelled', () => {
    for (const s of ['submitted', 'under_review', 'approved', 'cancelled', 'on_hold'] as const) expect(allowedActions(ctx(s, 'assignee'))).toEqual([]);
  });

  it('the reviewer picks up, approves or sends back a submitted task', () => {
    expect(sorted(allowedActions(ctx('submitted', 'reviewer')))).toEqual(['approve', 'review', 'rework']);
    expect(sorted(allowedActions(ctx('under_review', 'reviewer')))).toEqual(['approve', 'rework']);
  });

  it('a reviewer cannot review a task that is still being worked on', () => {
    for (const s of ['assigned', 'in_progress', 'rework', 'on_hold', 'approved', 'cancelled'] as const) expect(allowedActions(ctx(s, 'reviewer'))).toEqual([]);
  });

  it('the assigner puts open tasks on hold or cancels them, resumes a held one, and stops a held one for good', () => {
    for (const s of ['assigned', 'in_progress', 'submitted', 'under_review', 'rework'] as const) expect(sorted(allowedActions(ctx(s, 'assigner')))).toEqual(['cancel', 'hold']);
    expect(sorted(allowedActions(ctx('on_hold', 'assigner')))).toEqual(['cancel', 'resume']);
    expect(allowedActions(ctx('approved', 'assigner'))).toEqual([]);
    expect(allowedActions(ctx('cancelled', 'assigner'))).toEqual([]);
  });

  it('an assigner who is also the reviewer can do both sets of things', () => {
    expect(sorted(allowedActions(ctx('submitted', 'both')))).toEqual(['approve', 'cancel', 'hold', 'review', 'rework']);
  });

  it('nobody else can do anything', () => {
    for (const s of ALL) expect(allowedActions(ctx(s, 'nobody'))).toEqual([]);
  });

  it('nobody reviews, holds or cancels their own task', () => {
    for (const s of ALL) {
      const own = { ...ctx(s, 'both'), isAssignee: true };
      const out = allowedActions(own);
      expect(out).not.toContain('approve');
      expect(out).not.toContain('rework');
      expect(out).not.toContain('review');
      expect(out).not.toContain('hold');
      expect(out).not.toContain('cancel');
      expect(out).not.toContain('resume');
    }
  });
});

describe('personal to-dos', () => {
  it('the owner starts, marks done, reopens and cancels; there is no review, rating or hold', () => {
    expect(sorted(allowedActions(ctx('assigned', 'assignee', true)))).toEqual(['cancel', 'done', 'start']);
    expect(sorted(allowedActions(ctx('in_progress', 'assignee', true)))).toEqual(['cancel', 'done']);
    expect(allowedActions(ctx('approved', 'assignee', true))).toEqual(['reopen']);
    expect(allowedActions(ctx('cancelled', 'assignee', true))).toEqual([]);
  });

  it('nobody but the owner can touch a personal to-do, not even an assigner or reviewer', () => {
    for (const s of ALL) {
      expect(allowedActions(ctx(s, 'both', true))).toEqual([]);
      expect(allowedActions(ctx(s, 'nobody', true))).toEqual([]);
    }
  });

  it('done needs no rating and no reason; it closes the to-do without a review row', () => {
    const r = evaluateAction('done', ctx('assigned', 'assignee', true));
    expect(r).toMatchObject({ ok: true, to: 'approved', effects: { setClosedAt: true, writesReview: false } });
    expect(evaluateAction('cancel', ctx('assigned', 'assignee', true))).toMatchObject({ ok: true, to: 'cancelled' });
    expect(evaluateAction('reopen', ctx('approved', 'assignee', true))).toMatchObject({ ok: true, to: 'assigned', effects: { clearClosedAt: true } });
  });
});

describe('evaluating an action', () => {
  it('refuses an action that is not allowed', () => {
    expect(evaluateAction('approve', ctx('in_progress', 'reviewer'))).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(evaluateAction('start', ctx('in_progress', 'assignee'))).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(evaluateAction('approve', ctx('submitted', 'assignee'), { rating: 5 })).toMatchObject({ ok: false, code: 'not_allowed' });
  });

  it('approve needs a rating from 1 to 5', () => {
    const c = ctx('submitted', 'reviewer');
    for (const rating of [undefined, null, 0, 6, 3.5, -1]) expect(evaluateAction('approve', c, { rating })).toMatchObject({ ok: false, code: 'rating_required' });
    for (const rating of [1, 2, 3, 4, 5]) expect(evaluateAction('approve', c, { rating })).toMatchObject({ ok: true, to: 'approved' });
  });

  it('rework, hold and cancel need a reason', () => {
    expect(evaluateAction('rework', ctx('submitted', 'reviewer'), { reason: '' })).toMatchObject({ ok: false, code: 'reason_required' });
    expect(evaluateAction('rework', ctx('submitted', 'reviewer'), { reason: '  ' })).toMatchObject({ ok: false, code: 'reason_required' });
    expect(evaluateAction('rework', ctx('submitted', 'reviewer'), { reason: 'Tests are missing' })).toMatchObject({ ok: true, to: 'rework' });
    expect(evaluateAction('hold', ctx('in_progress', 'assigner'), {})).toMatchObject({ ok: false, code: 'reason_required' });
    expect(evaluateAction('hold', ctx('in_progress', 'assigner'), { reason: 'Client paused the work' })).toMatchObject({ ok: true, to: 'on_hold' });
    expect(evaluateAction('cancel', ctx('assigned', 'assigner'), { reason: 'No longer needed' })).toMatchObject({ ok: true, to: 'cancelled' });
    expect(evaluateAction('cancel', ctx('assigned', 'assigner'), { reason: 'x' })).toMatchObject({ ok: false, code: 'reason_required' });
  });

  it('start, submit, review and resume need no reason', () => {
    expect(evaluateAction('start', ctx('assigned', 'assignee'))).toMatchObject({ ok: true, to: 'in_progress' });
    expect(evaluateAction('submit', ctx('in_progress', 'assignee'))).toMatchObject({ ok: true, to: 'submitted' });
    expect(evaluateAction('review', ctx('submitted', 'reviewer'))).toMatchObject({ ok: true, to: 'under_review' });
    expect(evaluateAction('resume', ctx('on_hold', 'assigner'))).toMatchObject({ ok: true, to: 'in_progress' });
  });

  it('says what else changes: first start, submit time, rework count, closing, and the review record', () => {
    expect(evaluateAction('start', ctx('assigned', 'assignee'), {}, null)).toMatchObject({ effects: { setStartedAt: true } });
    expect(evaluateAction('start', ctx('rework', 'assignee'), {}, new Date())).toMatchObject({ effects: { setStartedAt: false } });
    expect(evaluateAction('submit', ctx('in_progress', 'assignee'))).toMatchObject({ effects: { setSubmittedAt: true } });
    expect(evaluateAction('rework', ctx('under_review', 'reviewer'), { reason: 'Fix the tests' })).toMatchObject({ effects: { incrementRework: true, writesReview: true } });
    expect(evaluateAction('approve', ctx('under_review', 'reviewer'), { rating: 4 })).toMatchObject({ effects: { setClosedAt: true, writesReview: true } });
    expect(evaluateAction('cancel', ctx('on_hold', 'assigner'), { reason: 'Dropped' })).toMatchObject({ effects: { setClosedAt: true, writesReview: false } });
    expect(evaluateAction('hold', ctx('in_progress', 'assigner'), { reason: 'Paused' })).toMatchObject({ effects: { setClosedAt: false, incrementRework: false } });
  });

  it('every action has a target status, and the whole flow works end to end', () => {
    expect(Object.keys(ACTION_TARGET).sort()).toEqual(['approve', 'cancel', 'done', 'hold', 'reopen', 'resume', 'review', 'rework', 'start', 'submit']);
    // assigned -> in progress -> submitted -> under review -> rework -> submitted -> approved
    let status: TaskStatusName = 'assigned';
    const step = (action: TaskActionName, who: 'assignee' | 'reviewer', input = {}) => {
      const r = evaluateAction(action, ctx(status, who), input);
      expect(r.ok).toBe(true);
      if (r.ok) status = r.to;
    };
    step('start', 'assignee');
    step('submit', 'assignee');
    step('review', 'reviewer');
    step('rework', 'reviewer', { reason: 'Please add tests' });
    expect(status).toBe('rework');
    step('submit', 'assignee');
    step('approve', 'reviewer', { rating: 5 });
    expect(status).toBe('approved');
    expect(allowedActions(ctx(status, 'both'))).toEqual([]);
  });
});

describe('open, settled and overdue', () => {
  const past = new Date('2026-11-10T13:00:00Z');
  const future = new Date('2026-11-30T13:00:00Z');
  const now = new Date('2026-11-16T05:00:00Z');

  it('open statuses are everything except approved and cancelled', () => {
    expect(OPEN_STATUSES).toHaveLength(6);
    expect(isOpen('approved')).toBe(false);
    expect(isOpen('cancelled')).toBe(false);
    expect(isOpen('on_hold')).toBe(true);
  });

  it('a task waiting for the reviewer, or finished, is settled', () => {
    expect(isWaitingOnReviewer('submitted')).toBe(true);
    expect(isWaitingOnReviewer('under_review')).toBe(true);
    expect(isSettled('approved')).toBe(true);
    expect(isSettled('submitted')).toBe(true);
    expect(isSettled('in_progress')).toBe(false);
  });

  it('overdue is a flag on an open task that is past its deadline and not waiting on the reviewer', () => {
    expect(isOverdue({ status: 'in_progress', deadline: past }, now)).toBe(true);
    expect(isOverdue({ status: 'assigned', deadline: past }, now)).toBe(true);
    expect(isOverdue({ status: 'rework', deadline: past }, now)).toBe(true);
    expect(isOverdue({ status: 'in_progress', deadline: future }, now)).toBe(false);
    expect(isOverdue({ status: 'submitted', deadline: past }, now)).toBe(false);
    expect(isOverdue({ status: 'under_review', deadline: past }, now)).toBe(false);
    expect(isOverdue({ status: 'approved', deadline: past }, now)).toBe(false);
    expect(isOverdue({ status: 'cancelled', deadline: past }, now)).toBe(false);
  });
});
