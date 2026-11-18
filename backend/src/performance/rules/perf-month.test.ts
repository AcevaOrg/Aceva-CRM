import { describe, expect, it } from 'vitest';
import { buildTrend, inMonth, isMonth, monthLabel, monthOf, monthsBefore, monthsToEnsure, monthWindow, nextMonth, previousMonth, scorecardJobKey, scorecardRunAt, taskBelongsToMonth } from './perf-month';

describe('months (Pakistan time, UTC+5)', () => {
  it('names the month of a moment in Pakistan time, not UTC', () => {
    expect(monthOf(new Date('2026-11-17T10:00:00Z'))).toBe('2026-11');
    // 20:00 UTC on 31 Oct is already 01:00 on 1 Nov in Pakistan
    expect(monthOf(new Date('2026-10-31T20:00:00Z'))).toBe('2026-11');
    expect(monthOf(new Date('2026-10-31T18:59:59Z'))).toBe('2026-10');
  });

  it('steps back and forward over a year end', () => {
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(nextMonth('2025-12')).toBe('2026-01');
    expect(previousMonth('2026-11')).toBe('2026-10');
    expect(nextMonth('2026-10')).toBe('2026-11');
  });

  it('lists the months before a month, oldest first', () => {
    expect(monthsBefore('2026-02', 4)).toEqual(['2025-10', '2025-11', '2025-12', '2026-01']);
    expect(monthsBefore('2026-11', 0)).toEqual([]);
  });

  it('knows what a month looks like', () => {
    expect(isMonth('2026-10')).toBe(true);
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-10', '2026-10-01', '']) expect(isMonth(bad)).toBe(false);
    expect(() => nextMonth('nope')).toThrow();
  });

  it('a month runs from midnight Pakistan time on the 1st to midnight on the 1st of the next month', () => {
    const w = monthWindow('2026-11');
    expect(w.start.toISOString()).toBe('2026-10-31T19:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-11-30T19:00:00.000Z');
    expect(monthWindow('2026-12').end.toISOString()).toBe('2026-12-31T19:00:00.000Z');
  });

  it('inMonth includes the first instant and leaves out the next month first instant', () => {
    expect(inMonth(new Date('2026-10-31T19:00:00.000Z'), '2026-11')).toBe(true);
    expect(inMonth(new Date('2026-10-31T18:59:59.999Z'), '2026-11')).toBe(false);
    expect(inMonth(new Date('2026-11-30T18:59:59.999Z'), '2026-11')).toBe(true);
    expect(inMonth(new Date('2026-11-30T19:00:00.000Z'), '2026-11')).toBe(false);
  });

  it('labels a month for mails', () => {
    expect(monthLabel('2026-10')).toBe('October 2026');
    expect(monthLabel('2026-01')).toBe('January 2026');
  });
});

describe('which tasks belong to a month', () => {
  it('a task belongs to the month of its deadline, in Pakistan time', () => {
    expect(taskBelongsToMonth({ personal: false, deadline: new Date('2026-10-15T08:00:00Z') }, '2026-10')).toBe(true);
    expect(taskBelongsToMonth({ personal: false, deadline: new Date('2026-10-15T08:00:00Z') }, '2026-11')).toBe(false);
    // due 23:30 Pakistan time on 31 Oct = 18:30 UTC: still October
    expect(taskBelongsToMonth({ personal: false, deadline: new Date('2026-10-31T18:30:00Z') }, '2026-10')).toBe(true);
    // due 00:30 Pakistan time on 1 Nov = 19:30 UTC on 31 Oct: November
    expect(taskBelongsToMonth({ personal: false, deadline: new Date('2026-10-31T19:30:00Z') }, '2026-10')).toBe(false);
    expect(taskBelongsToMonth({ personal: false, deadline: new Date('2026-10-31T19:30:00Z') }, '2026-11')).toBe(true);
  });

  it('a personal to-do never belongs to a month', () => {
    expect(taskBelongsToMonth({ personal: true, deadline: new Date('2026-10-15T08:00:00Z') }, '2026-10')).toBe(false);
  });
});

describe('the monthly job', () => {
  it('has one job per month and runs 10 minutes past midnight Pakistan time on the 1st of the next month', () => {
    expect(scorecardJobKey('2026-10')).toBe('scorecard.monthly:2026-10');
    expect(scorecardRunAt('2026-10').toISOString()).toBe('2026-10-31T19:10:00.000Z');
    expect(scorecardRunAt('2026-12').toISOString()).toBe('2026-12-31T19:10:00.000Z');
  });

  it('keeps the job of the month that just closed and the current one, never older months', () => {
    expect(monthsToEnsure(new Date('2026-11-17T10:00:00Z'))).toEqual(['2026-10', '2026-11']);
    expect(monthsToEnsure(new Date('2026-10-31T19:05:00Z'))).toEqual(['2026-10', '2026-11']);
    expect(monthsToEnsure(new Date('2027-01-02T10:00:00Z'))).toEqual(['2026-12', '2027-01']);
  });
});

describe('buildTrend', () => {
  const closed = [
    { month: '2026-04', score: 70, status: 'acknowledged' },
    { month: '2026-05', score: 72, status: 'acknowledged' },
    { month: '2026-06', score: 75, status: 'acknowledged' },
    { month: '2026-07', score: 74, status: 'acknowledged' },
    { month: '2026-08', score: 80, status: 'released' },
    { month: '2026-09', score: 82, status: 'released' },
    { month: '2026-10', score: 90, status: 'draft' },
  ];

  it('the employee sees released months only: the last 6 closed months, then the live month', () => {
    const t = buildTrend(closed, { liveMonth: '2026-11', liveScore: 88, includeDrafts: false });
    expect(t.map((p) => p.month)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-11']);
    expect(t.at(-1)).toEqual({ month: '2026-11', score: 88 });
  });

  it('people above see drafts too', () => {
    const t = buildTrend(closed, { liveMonth: '2026-11', liveScore: 88, includeDrafts: true });
    expect(t.map((p) => p.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  });

  it('leaves out months without a score and a live month without a score', () => {
    const t = buildTrend([{ month: '2026-09', score: null, status: 'released' }, { month: '2026-10', score: 60, status: 'released' }], { liveMonth: '2026-11', liveScore: null, includeDrafts: false });
    expect(t).toEqual([{ month: '2026-10', score: 60 }]);
  });

  it('ignores the live month and later months in the closed list', () => {
    const t = buildTrend([{ month: '2026-11', score: 50, status: 'released' }], { liveMonth: '2026-11', liveScore: 55, includeDrafts: true });
    expect(t).toEqual([{ month: '2026-11', score: 55 }]);
  });
});
