import { describe, expect, it } from 'vitest';
import { NotBuiltAttendanceSource, type AttendanceSource } from '../attendance-source';
import { NotBuiltSalesSource, type SalesSource } from '../sales-source';
import { buildFigures } from './perf-figures';
import type { SalesDetail, ScorecardTaskFacts } from './perf-tasks';

/**
 * The stand-ins for Module 7 (attendance) and Module 15 (sales) never invent a number, and a real source plugs in with no change
 * to the maths. The figures are the same worked month as perf-figures.test.ts.
 */
const STANDARD = { quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10 };
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
/** Ratings 5,4,3,4,5 on points 3,2,5,1,3; one late, one reworked. */
const month = (): ScorecardTaskFacts[] => [
  task({ points: 3, rating: 5 }),
  task({ points: 2, rating: 4, onTime: false }),
  task({ points: 5, rating: 3, reworked: true }),
  task({ points: 1, rating: 4 }),
  task({ points: 3, rating: 5 }),
];

describe('the attendance stand-in (until Module 7)', () => {
  const source: AttendanceSource = new NotBuiltAttendanceSource();

  it('has no figure for anybody in any month: never 100, never 0, never a guess', async () => {
    for (const [person, m] of [
      ['0f6c1c2e-0000-4000-8000-000000000001', '2026-10'],
      ['0f6c1c2e-0000-4000-8000-000000000002', '2026-10'],
      ['0f6c1c2e-0000-4000-8000-000000000001', '2026-11'],
      ['someone-who-does-not-exist', '1999-01'],
    ] as const) {
      expect(await source.rateFor(person, m)).toEqual({ available: false });
    }
  });

  it('a standard scorecard made with it leaves attendance out: null, named in "unmeasured", its weight shared among the measured metrics', async () => {
    const answer = await source.rateFor('p1', '2026-10');
    const f = buildFigures({ kind: 'standard', tasks: month(), now: NOW, attendance: answer.available ? answer.rate : null, sales: null, workloadHours: 0, weights: STANDARD });
    expect(f.metrics.attendance).toBeNull();
    expect(f.unmeasured).toEqual([{ key: 'attendance', reason: 'attendance_not_available' }]);
    // (35 x 81.4 + 25 x 80 + 20 x 100 + 10 x 80) / 90 = 84.99 -> 85: nobody gains or loses points for the missing figure
    expect(f.score).toBe(85);
  });

  it('a real source (Module 7) plugs in with no change to the maths: the figure is a percentage, 95 means 95%', async () => {
    const real: AttendanceSource = { rateFor: async () => ({ available: true, rate: 95 }) };
    const answer = await real.rateFor('p1', '2026-10');
    const f = buildFigures({ kind: 'standard', tasks: month(), now: NOW, attendance: answer.available ? answer.rate : null, sales: null, workloadHours: 0, weights: STANDARD });
    expect(f.metrics.attendance).toBe(95);
    expect(f.unmeasured).toEqual([]);
    // 0.35 x 81.4 + 0.25 x 80 + 0.20 x 100 + 0.10 x 80 + 0.10 x 95 = 85.99 -> 86 (the plan's formula)
    expect(f.score).toBe(86);
  });
});

describe('the sales stand-in (until Module 15)', () => {
  const source: SalesSource = new NotBuiltSalesSource();

  it('has no figures for anybody: not the mock screens\' made-up numbers, not zeros', async () => {
    for (const person of ['p1', 'p2', 'p3']) expect(await source.figuresFor(person, '2026-10')).toEqual({ available: false });
  });

  it('a sales scorecard made with it has no V, M, W or D and NO score or band (attendance alone says nothing about sales work)', async () => {
    const answer = await source.figuresFor('p1', '2026-10');
    const f = buildFigures({ kind: 'sales', tasks: [], now: NOW, attendance: null, sales: answer.available ? answer.detail : null, workloadHours: 0, weights: SALES });
    expect(f.metrics).toEqual({ activity: null, meetings: null, won: null, dataQuality: null, attendance: null });
    expect(f.unmeasured.map((u) => [u.key, u.reason])).toEqual([
      ['activity', 'sales_not_available'],
      ['meetings', 'sales_not_available'],
      ['won', 'sales_not_available'],
      ['dataQuality', 'sales_not_available'],
      ['attendance', 'attendance_not_available'],
    ]);
    expect(f.score).toBeNull();
    expect(f.band).toBeNull();
    expect(f.salesDetail).toBeNull();
  });

  it('a real source (Module 15) plugs in with no change to the maths: a real month of zeros is a real score, not "not available"', async () => {
    const detail: SalesDetail = { targetDaysMet: 15, workingDays: 20, meetings: 8, meetingTarget: 10, wonValueUsd: 9000, wonTargetUsd: 10000, bounceRate: 3, duplicates: 0 };
    const real: SalesSource = { figuresFor: async () => ({ available: true, detail }) };
    const answer = await real.figuresFor('p1', '2026-10');
    const f = buildFigures({ kind: 'sales', tasks: [], now: NOW, attendance: 100, sales: answer.available ? answer.detail : null, workloadHours: 0, weights: SALES });
    // V 75, M 80, W 90, D 100, A 100: 0.20 x 75 + 0.25 x 80 + 0.30 x 90 + 0.10 x 100 + 0.15 x 100 = 15 + 20 + 27 + 10 + 15 = 87
    expect(f.metrics).toEqual({ activity: 75, meetings: 80, won: 90, dataQuality: 100, attendance: 100 });
    expect(f.score).toBe(87);
    expect(f.band).toBe('excellent');
    expect(f.unmeasured).toEqual([]);
  });
});
