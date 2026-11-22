import { describe, expect, it } from 'vitest';
import { buildFigures, rescoreStandard, withCurrentRatings } from './perf-figures';
import type { ScorecardTaskFacts, SalesDetail } from './perf-tasks';

const STANDARD = { quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10 };
const STANDARD_V1 = { quality: 40, onTime: 25, completion: 20, rework: 5, attendance: 10 };
const SALES = { activity: 20, meetings: 25, won: 30, dataQuality: 10, attendance: 15 };
const NOW = new Date('2026-11-01T02:00:00Z');

let seq = 0;
const task = (o: Partial<ScorecardTaskFacts> = {}): ScorecardTaskFacts => ({
  taskId: `t-${++seq}`,
  number: `TSK-${String(seq).padStart(4, '0')}`,
  title: 'Task',
  size: 'M',
  points: 3,
  rating: 4,
  onTime: true,
  reworked: false,
  extensions: 0,
  status: 'approved',
  deadline: new Date('2026-10-15T08:00:00Z'),
  ...o,
});

/** Five approved tasks: ratings 5,4,3,4,5 on points 3,2,5,1,3; one late, one reworked. */
const month = (): ScorecardTaskFacts[] => [
  task({ points: 3, rating: 5 }),
  task({ points: 2, rating: 4, onTime: false }),
  task({ points: 5, rating: 3, reworked: true }),
  task({ points: 1, rating: 4 }),
  task({ points: 3, rating: 5 }),
];

describe('buildFigures, standard scorecard', () => {
  it('works out the four task metrics, the score and the band; attendance is not available (Module 7) and its weight is shared', () => {
    const f = buildFigures({ kind: 'standard', tasks: month(), now: NOW, attendance: null, sales: null, workloadHours: 12.34, weights: STANDARD });
    // quality (5x3 + 4x2 + 3x5 + 4x1 + 5x3) / 14 x 20 = 57 / 14 x 20 = 81.4; on time 4/5 = 80; completion 100; rework 1/5 = 20
    expect(f.metrics).toEqual({ quality: 81.4, onTime: 80, completion: 100, rework: 20, attendance: null, workloadHours: 12.3 });
    expect(f.unmeasured).toEqual([{ key: 'attendance', reason: 'attendance_not_available' }]);
    // (35 x 81.4 + 25 x 80 + 20 x 100 + 10 x 80) / 90 = 84.99 -> 85
    expect(f.score).toBe(85);
    expect(f.band).toBe('excellent');
    expect(f.taskCount).toBe(5);
    expect(f.smallSample).toBe(false);
    expect(f.salesDetail).toBeNull();
    expect(f.tasks).toHaveLength(5);
    expect(f.tasks.every((t) => t.counted)).toBe(true);
  });

  it('uses attendance when the attendance source has a figure (Module 7), with the exact formula', () => {
    const f = buildFigures({ kind: 'standard', tasks: month(), now: NOW, attendance: 95, sales: null, workloadHours: 0, weights: STANDARD });
    expect(f.unmeasured).toEqual([]);
    expect(f.metrics.attendance).toBe(95);
    // 0.35 x 81.4 + 0.25 x 80 + 0.20 x 100 + 0.10 x 80 + 0.10 x 95 = 28.49 + 20 + 20 + 8 + 9.5 = 85.99 -> 86
    expect(f.score).toBe(86);
  });

  it('a month with fewer than 5 counted tasks is a small sample', () => {
    const f = buildFigures({ kind: 'standard', tasks: month().slice(0, 4), now: NOW, attendance: null, sales: null, workloadHours: 0, weights: STANDARD });
    expect(f.taskCount).toBe(4);
    expect(f.smallSample).toBe(true);
  });

  it('cancelled tasks are in the list but do not count', () => {
    const tasks = [...month(), task({ status: 'cancelled', rating: null, points: 5, onTime: false })];
    const f = buildFigures({ kind: 'standard', tasks, now: NOW, attendance: null, sales: null, workloadHours: 0, weights: STANDARD });
    expect(f.taskCount).toBe(5);
    expect(f.tasks).toHaveLength(6);
    expect(f.tasks.at(-1)).toMatchObject({ status: 'cancelled', counted: false });
    expect(f.metrics.completion).toBe(100);
  });

  it('an open task not yet due does not count (live month); once its deadline passes it lowers completion', () => {
    const open = task({ status: 'open', rating: null, points: 5, onTime: true, deadline: new Date('2026-11-25T08:00:00Z') });
    const live = buildFigures({ kind: 'standard', tasks: [...month(), open], now: NOW, attendance: null, sales: null, workloadHours: 0, weights: STANDARD });
    expect(live.tasks.at(-1)).toMatchObject({ counted: false });
    expect(live.taskCount).toBe(5);
    expect(live.metrics.completion).toBe(100);
    const later = buildFigures({ kind: 'standard', tasks: [...month(), open], now: new Date('2026-11-26T00:00:00Z'), attendance: null, sales: null, workloadHours: 0, weights: STANDARD });
    expect(later.tasks.at(-1)).toMatchObject({ counted: true });
    expect(later.taskCount).toBe(6);
    expect(later.metrics.completion).toBe(73.7);
  });

  it('nothing to measure: no tasks gives no score and no band, and says why', () => {
    const f = buildFigures({ kind: 'standard', tasks: [], now: NOW, attendance: null, sales: null, workloadHours: 0, weights: STANDARD });
    expect(f.score).toBeNull();
    expect(f.band).toBeNull();
    expect(f.taskCount).toBe(0);
    expect(f.smallSample).toBe(true);
    expect(f.metrics).toMatchObject({ quality: null, onTime: null, completion: null, rework: null, attendance: null });
    expect(f.unmeasured.map((u) => `${u.key}:${u.reason}`)).toEqual([
      'quality:nothing_to_measure',
      'onTime:nothing_to_measure',
      'completion:nothing_to_measure',
      'rework:nothing_to_measure',
      'attendance:attendance_not_available',
    ]);
  });

  it('a person with only approved unrated tasks has completion but no quality', () => {
    const f = buildFigures({ kind: 'standard', tasks: [task({ rating: null })], now: NOW, attendance: null, sales: null, workloadHours: 0, weights: STANDARD });
    expect(f.metrics.quality).toBeNull();
    expect(f.metrics.completion).toBe(100);
    expect(f.unmeasured.some((u) => u.key === 'quality')).toBe(true);
  });

  it('keeps the weights version it is given (an older version gives an older result)', () => {
    const a = buildFigures({ kind: 'standard', tasks: month(), now: NOW, attendance: 95, sales: null, workloadHours: 0, weights: STANDARD });
    const b = buildFigures({ kind: 'standard', tasks: month(), now: NOW, attendance: 95, sales: null, workloadHours: 0, weights: STANDARD_V1 });
    expect(a.score).not.toBe(b.score);
  });
});

describe('buildFigures, sales scorecard (nothing is invented)', () => {
  const good: SalesDetail = { targetDaysMet: 18, workingDays: 21, meetings: 7, meetingTarget: 8, wonValueUsd: 3200, wonTargetUsd: 4000, bounceRate: 2.4, duplicates: 0 };

  it('without the sales figures (Module 15) there is no score, whatever attendance says', () => {
    const f = buildFigures({ kind: 'sales', tasks: [], now: NOW, attendance: 94, sales: null, workloadHours: 0, weights: SALES });
    expect(f.score).toBeNull();
    expect(f.band).toBeNull();
    expect(f.metrics).toEqual({ activity: null, meetings: null, won: null, dataQuality: null, attendance: 94 });
    expect(f.unmeasured.map((u) => `${u.key}:${u.reason}`)).toEqual(['activity:sales_not_available', 'meetings:sales_not_available', 'won:sales_not_available', 'dataQuality:sales_not_available']);
    expect(f.taskCount).toBe(0);
    expect(f.smallSample).toBe(false);
    expect(f.tasks).toEqual([]);
  });

  it('with the sales figures and attendance, the frontend number', () => {
    const f = buildFigures({ kind: 'sales', tasks: [], now: NOW, attendance: 94.04, sales: good, workloadHours: 0, weights: SALES });
    expect(f.metrics).toEqual({ activity: 85.7, meetings: 87.5, won: 80, dataQuality: 100, attendance: 94 });
    expect(f.score).toBe(87.1);
    expect(f.band).toBe('excellent');
    expect(f.salesDetail).toEqual(good);
    expect(f.taskCount).toBe(21);
    expect(f.unmeasured).toEqual([]);
  });

  it('with the sales figures but no attendance, attendance is left out of the score', () => {
    const f = buildFigures({ kind: 'sales', tasks: [], now: NOW, attendance: null, sales: good, workloadHours: 0, weights: SALES });
    expect(f.metrics.attendance).toBeNull();
    expect(f.unmeasured).toEqual([{ key: 'attendance', reason: 'attendance_not_available' }]);
    // (20 x 85.7 + 25 x 87.5 + 30 x 80 + 10 x 100) / 85 = 85.9
    expect(f.score).toBe(85.9);
  });

  it('ignores any tasks a salesperson has: they are scored on the sales figures', () => {
    const f = buildFigures({ kind: 'sales', tasks: month(), now: NOW, attendance: null, sales: null, workloadHours: 9, weights: SALES });
    expect(f.tasks).toEqual([]);
    expect(f.metrics).not.toHaveProperty('workloadHours');
  });
});

describe('the recompute after a dispute changed a rating', () => {
  const asScorecard = (tasks: ScorecardTaskFacts[]) => buildFigures({ kind: 'standard', tasks, now: NOW, attendance: 95, sales: null, workloadHours: 20, weights: STANDARD_V1 });

  it('the current rating of a task is the latest changed dispute, else the stored one; the original is kept', () => {
    const tasks = [task({ taskId: 'a', rating: 3 }), task({ taskId: 'b', rating: 5 })];
    const out = withCurrentRatings(tasks, [
      { taskId: 'a', newRating: 4, decidedAt: new Date('2026-11-05T10:00:00Z') },
      { taskId: 'a', newRating: 5, decidedAt: new Date('2026-11-09T10:00:00Z') },
    ]);
    expect(out.map((t) => [t.taskId, t.rating, t.originalRating])).toEqual([
      ['a', 5, 3],
      ['b', 5, null],
    ]);
  });

  it('works out the task metrics again with the weights version the scorecard was made with, and keeps attendance, workload and the rest', () => {
    const tasks = month();
    const before = asScorecard(tasks);
    // the employee disputed the 3-star task (5 points) and the decider changed it to 5
    const changed = withCurrentRatings(
      before.tasks,
      [{ taskId: tasks[2].taskId, newRating: 5, decidedAt: new Date('2026-11-05T10:00:00Z') }],
    );
    const after = rescoreStandard(before.metrics, changed, STANDARD_V1);
    expect(before.metrics.quality).toBe(81.4);
    // (5x3 + 4x2 + 5x5 + 4x1 + 5x3) / 14 x 20 = 67 / 14 x 20 = 95.7
    expect(after.metrics.quality).toBe(95.7);
    expect(after.metrics).toMatchObject({ onTime: before.metrics.onTime, completion: before.metrics.completion, rework: before.metrics.rework, attendance: 95, workloadHours: 20 });
    // 0.40 x 95.7 + 0.25 x 80 + 0.20 x 100 + 0.05 x 80 + 0.10 x 95 = 38.28 + 20 + 20 + 4 + 9.5 = 91.78 -> 91.8
    expect(after.score).toBe(91.8);
    expect(after.band).toBe('excellent');
    expect(after.score).toBeGreaterThan(before.score ?? 0);
  });

  it('with the old weights version, not the current one', () => {
    const tasks = month();
    const before = asScorecard(tasks);
    const sameTasks = withCurrentRatings(before.tasks, []);
    const v1 = rescoreStandard(before.metrics, sameTasks, STANDARD_V1);
    const v2 = rescoreStandard(before.metrics, sameTasks, STANDARD);
    expect(v1.score).toBe(before.score);
    expect(v2.score).not.toBe(before.score);
  });

  it('a metric that was not measured stays not measured', () => {
    const noRatings = buildFigures({ kind: 'standard', tasks: [task({ rating: null })], now: NOW, attendance: null, sales: null, workloadHours: 0, weights: STANDARD });
    const after = rescoreStandard(noRatings.metrics, noRatings.tasks, STANDARD);
    expect(after.metrics.quality).toBeNull();
    expect(after.score).toBe(noRatings.score);
  });

  it('a tasks that did not count stays out', () => {
    const open = task({ status: 'open', rating: null, points: 5, deadline: new Date('2026-11-25T08:00:00Z') });
    const before = buildFigures({ kind: 'standard', tasks: [...month(), open], now: NOW, attendance: null, sales: null, workloadHours: 0, weights: STANDARD });
    const after = rescoreStandard(before.metrics, before.tasks, STANDARD);
    expect(after.metrics.completion).toBe(100);
    expect(after.score).toBe(before.score);
  });
});
