import { describe, expect, it } from 'vitest';
import { checkRunnable, ensureRunAt, failureMessage, groupByReviewer, runSummary, splitExisting } from './auto-monthly';
import { monthsToEnsure, monthWindow, scorecardJobKey, scorecardRunAt } from './perf-month';

/** A moment in Pakistan time (UTC+5, no daylight saving). */
const pk = (day: string, time = '12:00') => new Date(`${day}T${time}:00+05:00`);

describe('which months may be run', () => {
  it('the month that just closed and the current month may; a future month may not', () => {
    const now = pk('2026-11-17');
    expect(checkRunnable('2026-10', now)).toEqual({ ok: true });
    expect(checkRunnable('2026-11', now)).toEqual({ ok: true });
    const future = checkRunnable('2026-12', now);
    expect(future.ok).toBe(false);
    expect(future.ok === false && future.message).toContain('has not started');
    expect(checkRunnable('2027-01', now).ok).toBe(false);
  });

  it('a month is judged in Pakistan time: at 00:30 on 1 November Pakistan time it is November (still October in UTC)', () => {
    const now = new Date('2026-10-31T19:30:00Z');
    expect(checkRunnable('2026-11', now)).toEqual({ ok: true });
    expect(checkRunnable('2026-11', new Date('2026-10-31T18:59:00Z')).ok).toBe(false); // 23:59 on 31 October Pakistan time
  });

  it('refuses anything that is not a month', () => {
    for (const bad of ['', '2026', '2026-13', '2026-00', '2026-1', 'October', '2026-10-01']) expect(checkRunnable(bad, pk('2026-11-17')).ok).toBe(false);
  });
});

describe('when the job of a month is due', () => {
  it('the current month waits for 00:10 Pakistan time on the 1st of next month', () => {
    const due = ensureRunAt('2026-11', pk('2026-11-17'));
    expect(due.toISOString()).toBe('2026-11-30T19:10:00.000Z');
    expect(due.getTime()).toBe(scorecardRunAt('2026-11').getTime());
    expect(due.getTime()).toBe(pk('2026-12-01', '00:10').getTime());
    expect(due.getTime()).toBe(monthWindow('2026-11').end.getTime() + 10 * 60_000);
  });

  it('the month that just closed is due at 00:10 on the 1st, or right away when that moment has passed (a server that was down)', () => {
    expect(ensureRunAt('2026-10', pk('2026-11-01', '00:05')).getTime()).toBe(pk('2026-11-01', '00:10').getTime());
    const late = pk('2026-11-01', '00:11');
    expect(ensureRunAt('2026-10', late).getTime()).toBe(late.getTime());
    const muchLater = pk('2026-11-17');
    expect(ensureRunAt('2026-10', muchLater).getTime()).toBe(muchLater.getTime());
  });

  it('the December job runs in January of the next year', () => {
    expect(ensureRunAt('2026-12', pk('2026-12-15')).getTime()).toBe(pk('2027-01-01', '00:10').getTime());
    expect(scorecardJobKey('2026-12')).toBe('scorecard.monthly:2026-12');
  });

  it('the months to make sure of are the one that just closed and the current one, nothing older', () => {
    expect(monthsToEnsure(pk('2026-11-17'))).toEqual(['2026-10', '2026-11']);
    expect(monthsToEnsure(pk('2027-01-01', '00:05'))).toEqual(['2026-12', '2027-01']);
    // at 00:30 on 1 November Pakistan time (19:30 UTC on 31 October) the month that just closed is October
    expect(monthsToEnsure(new Date('2026-10-31T19:30:00Z'))).toEqual(['2026-10', '2026-11']);
    expect(monthsToEnsure(new Date('2026-10-31T18:30:00Z'))).toEqual(['2026-09', '2026-10']);
  });
});

describe('who still needs a scorecard', () => {
  const people = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('splits those who have one (left alone) from those still to do, keeping the order', () => {
    const { todo, existing } = splitExisting(people, new Set(['b']));
    expect(todo.map((p) => p.id)).toEqual(['a', 'c']);
    expect(existing.map((p) => p.id)).toEqual(['b']);
  });

  it('everybody has one: nothing to do (a re-run); nobody has one: everybody', () => {
    expect(splitExisting(people, new Set(['a', 'b', 'c'])).todo).toEqual([]);
    expect(splitExisting(people, new Set()).existing).toEqual([]);
    expect(splitExisting([], new Set(['a'])).todo).toEqual([]);
  });
});

describe('the "drafts are waiting" digest: one entry per reviewer', () => {
  const reviewerOf = (empId: string): string | null => ({ 'ACV-0006': 'ACV-0004', 'ACV-0007': 'ACV-0004', 'ACV-0008': 'ACV-0004', 'ACV-0009': 'ACV-0003', 'ACV-0003': null })[empId] ?? null;
  const drafts = ['ACV-0009', 'ACV-0007', 'ACV-0006', 'ACV-0003', 'ACV-0008'].map((empId) => ({ empId }));

  it('groups the drafts by reviewer, counts them, sorts by reviewer and by person, and leaves out people with no reviewer', () => {
    expect(groupByReviewer(drafts, reviewerOf)).toEqual([
      { reviewer: 'ACV-0003', count: 1, employees: ['ACV-0009'] },
      { reviewer: 'ACV-0004', count: 3, employees: ['ACV-0006', 'ACV-0007', 'ACV-0008'] },
    ]);
  });

  it('limits the digest to the reviewers who got new drafts (a re-run mails nobody twice)', () => {
    expect(groupByReviewer(drafts, reviewerOf, new Set(['ACV-0004']))).toEqual([{ reviewer: 'ACV-0004', count: 3, employees: ['ACV-0006', 'ACV-0007', 'ACV-0008'] }]);
    expect(groupByReviewer(drafts, reviewerOf, new Set())).toEqual([]);
  });

  it('no drafts, no digest', () => {
    expect(groupByReviewer([], reviewerOf)).toEqual([]);
  });
});

describe('what the job reports', () => {
  const counts = { month: '2026-10', created: 10, existing: 1, autoReleased: 1, failed: 0 };

  it('the log line', () => {
    expect(runSummary(counts)).toBe('Scorecards for 2026-10: 10 made (1 released by the system), 1 already there, 0 failed');
  });

  it('the failure message says how many failed and that the job is retried', () => {
    expect(failureMessage({ ...counts, failed: 2 })).toBe('2 scorecards of 2026-10 could not be made (10 were); the job will be retried');
    expect(failureMessage({ ...counts, failed: 1 })).toContain('1 scorecard of 2026-10');
  });
});
