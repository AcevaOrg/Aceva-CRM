import { describe, expect, it } from 'vitest';
import { countsForMetrics, salesMetrics, taskMetrics, toScorecardTask, type MetricTask, type SalesDetail, type TaskRowFacts } from './perf-tasks';

const t = (o: Partial<MetricTask> & { status: MetricTask['status'] }): MetricTask => ({ points: 3, rating: null, onTime: true, reworked: false, ...o });

/**
 * Task sets run through the frontend's own taskMetrics (frontend/src/features/performance/logic.ts); the expected numbers are
 * what it returned. Same input, same numbers.
 */
describe('taskMetrics (same numbers as the frontend)', () => {
  it('a plain month', () => {
    const tasks = [
      t({ status: 'approved', points: 3, rating: 5 }),
      t({ status: 'approved', points: 2, rating: 4, onTime: false }),
      t({ status: 'approved', points: 5, rating: 3, reworked: true }),
      t({ status: 'approved', points: 1, rating: 4 }),
      t({ status: 'open', points: 3, onTime: false }),
    ];
    expect(taskMetrics(tasks)).toEqual({ quality: 76.4, onTime: 75, completion: 78.6, rework: 25, taskCount: 5 });
  });

  it('cancelled tasks do not count, a task waiting for review counts as submitted, a reworked open task as submitted and reworked', () => {
    const tasks = [
      t({ status: 'approved', points: 3, rating: 4 }),
      t({ status: 'cancelled', points: 5, rating: 1, onTime: false }),
      t({ status: 'submitted', points: 2 }),
      t({ status: 'open', points: 3, reworked: true, onTime: false }),
      t({ status: 'approved', points: 0, rating: 5 }),
    ];
    expect(taskMetrics(tasks)).toEqual({ quality: 85, onTime: 75, completion: 37.5, rework: 25, taskCount: 4 });
  });

  it('only open tasks: quality, on time and rework are not measurable, completion is 0', () => {
    expect(taskMetrics([t({ status: 'open', points: 3 }), t({ status: 'open', points: 2 })])).toEqual({ quality: null, onTime: null, completion: 0, rework: null, taskCount: 2 });
  });

  it('nothing to measure gives nulls, never a made-up number', () => {
    expect(taskMetrics([])).toEqual({ quality: null, onTime: null, completion: null, rework: null, taskCount: 0 });
    expect(taskMetrics([t({ status: 'cancelled' })])).toEqual({ quality: null, onTime: null, completion: null, rework: null, taskCount: 0 });
  });

  it('weights the rating by points: a 5-star XS (1 point) counts less than a 3-star L (5 points); 5 stars = 100', () => {
    const q = taskMetrics([t({ status: 'approved', points: 1, rating: 5 }), t({ status: 'approved', points: 5, rating: 3 })]).quality;
    // (5 x 1 + 3 x 5) / 6 x 20 = 66.7
    expect(q).toBe(66.7);
    expect(taskMetrics([t({ status: 'approved', points: 3, rating: 5 })]).quality).toBe(100);
  });

  it('completion is approved points / points due in the month', () => {
    const tasks = [t({ status: 'approved', points: 5, rating: 4 }), t({ status: 'open', points: 5 })];
    expect(taskMetrics(tasks).completion).toBe(50);
  });
});

describe('toScorecardTask', () => {
  const now = new Date('2026-11-01T02:00:00Z');
  const base: TaskRowFacts = {
    taskId: 'id-1',
    number: 'TSK-0001',
    title: 'x',
    size: 'M',
    points: 3,
    status: 'approved',
    deadline: new Date('2026-10-20T13:00:00Z'),
    submittedAt: new Date('2026-10-20T12:00:00Z'),
    reworkCount: 0,
    extensionsCount: 0,
    rating: 4,
  };

  it('handed in before the deadline is on time, after it is late', () => {
    expect(toScorecardTask(base, now).onTime).toBe(true);
    expect(toScorecardTask({ ...base, submittedAt: new Date('2026-10-20T13:00:00Z') }, now).onTime).toBe(true);
    expect(toScorecardTask({ ...base, submittedAt: new Date('2026-10-20T13:00:01Z') }, now).onTime).toBe(false);
  });

  it('an extension approved before the deadline is not late: the task carries the approved (later) deadline', () => {
    // first deadline 20 Oct, extended to 22 Oct, handed in on 21 Oct
    const extended = { ...base, deadline: new Date('2026-10-22T13:00:00Z'), submittedAt: new Date('2026-10-21T09:00:00Z'), extensionsCount: 1 };
    expect(toScorecardTask(extended, now)).toMatchObject({ onTime: true, extensions: 1 });
  });

  it('an extension asked for AFTER the deadline counts as late: the late extension does not rescue the task', () => {
    // due 10 Oct 18:00, a late request on the 12th was approved to the 15th, handed in on the 14th
    const due = new Date('2026-10-10T13:00:00Z');
    const lateExtended = { ...base, deadline: new Date('2026-10-15T13:00:00Z'), submittedAt: new Date('2026-10-14T09:00:00Z'), extensionsCount: 1, lateExtensionDeadlines: [due] };
    expect(toScorecardTask(lateExtended, now)).toMatchObject({ onTime: false, extensions: 1 });
    // the same hand-in with an extension that was asked for in time stays on time
    expect(toScorecardTask({ ...lateExtended, lateExtensionDeadlines: [] }, now).onTime).toBe(true);
    expect(toScorecardTask({ ...lateExtended, lateExtensionDeadlines: undefined }, now).onTime).toBe(true);
    // handed in before the first deadline: on time, whatever was asked for later
    expect(toScorecardTask({ ...lateExtended, submittedAt: new Date('2026-10-10T12:00:00Z') }, now).onTime).toBe(true);
    // an in-time extension (to the 12th) followed by a late one (to the 15th): measured against the 12th
    const second = { ...lateExtended, lateExtensionDeadlines: [new Date('2026-10-12T13:00:00Z')] };
    expect(toScorecardTask({ ...second, submittedAt: new Date('2026-10-12T12:00:00Z') }, now).onTime).toBe(true);
    expect(toScorecardTask({ ...second, submittedAt: new Date('2026-10-13T12:00:00Z') }, now).onTime).toBe(false);
  });

  it('maps the status: submitted and under review wait for review, approved and cancelled stay, the rest is open', () => {
    expect(toScorecardTask({ ...base, status: 'under_review' }, now).status).toBe('submitted');
    expect(toScorecardTask({ ...base, status: 'submitted' }, now).status).toBe('submitted');
    expect(toScorecardTask({ ...base, status: 'cancelled' }, now).status).toBe('cancelled');
    for (const status of ['assigned', 'in_progress', 'rework', 'on_hold'] as const) expect(toScorecardTask({ ...base, status }, now).status).toBe('open');
  });

  it('reworked = sent back at least once (also while it is open again)', () => {
    expect(toScorecardTask({ ...base, reworkCount: 0 }, now).reworked).toBe(false);
    expect(toScorecardTask({ ...base, status: 'in_progress', reworkCount: 2 }, now).reworked).toBe(true);
  });

  it('a task never handed in is on time only while its deadline has not passed', () => {
    const open = { ...base, status: 'in_progress' as const, submittedAt: null };
    expect(toScorecardTask({ ...open, deadline: new Date('2026-11-05T00:00:00Z') }, now).onTime).toBe(true);
    expect(toScorecardTask({ ...open, deadline: new Date('2026-10-30T00:00:00Z') }, now).onTime).toBe(false);
  });

  it('carries the rating, points and the deadline', () => {
    expect(toScorecardTask(base, now)).toMatchObject({ taskId: 'id-1', number: 'TSK-0001', points: 3, rating: 4, size: 'M' });
  });
});

describe('countsForMetrics', () => {
  const now = new Date('2026-11-01T02:00:00Z');
  const past = new Date('2026-10-30T00:00:00Z');
  const future = new Date('2026-11-20T00:00:00Z');

  it('never counts a cancelled task', () => {
    expect(countsForMetrics({ status: 'cancelled', deadline: past, reworked: true }, now)).toBe(false);
  });
  it('counts approved and submitted tasks whenever they are due', () => {
    expect(countsForMetrics({ status: 'approved', deadline: future, reworked: false }, now)).toBe(true);
    expect(countsForMetrics({ status: 'submitted', deadline: future, reworked: false }, now)).toBe(true);
  });
  it('counts an open task only once its deadline passed or it was sent back', () => {
    expect(countsForMetrics({ status: 'open', deadline: future, reworked: false }, now)).toBe(false);
    expect(countsForMetrics({ status: 'open', deadline: past, reworked: false }, now)).toBe(true);
    expect(countsForMetrics({ status: 'open', deadline: now, reworked: false }, now)).toBe(true);
    expect(countsForMetrics({ status: 'open', deadline: future, reworked: true }, now)).toBe(true);
  });
});

describe('salesMetrics (same numbers as the frontend)', () => {
  const good: SalesDetail = { targetDaysMet: 18, workingDays: 21, meetings: 7, meetingTarget: 8, wonValueUsd: 3200, wonTargetUsd: 4000, bounceRate: 2.4, duplicates: 0 };
  const weak: SalesDetail = { targetDaysMet: 13, workingDays: 21, meetings: 4, meetingTarget: 8, wonValueUsd: 900, wonTargetUsd: 4000, bounceRate: 4.1, duplicates: 1 };
  const over: SalesDetail = { targetDaysMet: 21, workingDays: 21, meetings: 12, meetingTarget: 8, wonValueUsd: 9500, wonTargetUsd: 4000, bounceRate: 12, duplicates: 3 };
  const zero: SalesDetail = { targetDaysMet: 0, workingDays: 0, meetings: 3, meetingTarget: 0, wonValueUsd: 100, wonTargetUsd: 0, bounceRate: 3, duplicates: 0 };

  it('good month', () => {
    expect(salesMetrics(good, 94.04)).toEqual({ activity: 85.7, meetings: 87.5, won: 80, dataQuality: 100, attendance: 94 });
  });
  it('weak month: 10 points off per 1% of bounce rate above 3% and per duplicate', () => {
    expect(salesMetrics(weak, 94.04)).toEqual({ activity: 61.9, meetings: 50, won: 22.5, dataQuality: 79, attendance: 94 });
  });
  it('targets are capped at 100 and data quality never goes below 0', () => {
    expect(salesMetrics(over, 94.04)).toEqual({ activity: 100, meetings: 100, won: 100, dataQuality: 0, attendance: 94 });
  });
  it('a missing target gives 0, not a division by zero', () => {
    expect(salesMetrics(zero, 94.04)).toEqual({ activity: 0, meetings: 0, won: 0, dataQuality: 100, attendance: 94 });
  });
  it('attendance stays null when it cannot be measured', () => {
    expect(salesMetrics(good, null).attendance).toBeNull();
  });
});
