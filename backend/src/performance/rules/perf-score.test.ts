import { describe, expect, it } from 'vitest';
import { bandOf, computeScore, contributions, metricKeys, percentsToFractions, round1, roundScore, validateWeights, weightsLabel, type MetricValues } from './perf-score';

const STANDARD = { quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10 };
const STANDARD_V1 = { quality: 40, onTime: 25, completion: 20, rework: 5, attendance: 10 };
const SALES = { activity: 20, meetings: 25, won: 30, dataQuality: 10, attendance: 15 };

/**
 * The expected values below were produced by running the frontend's own logic
 * (frontend/src/features/performance/logic.ts: computeScore, bandOf) on the same metrics, with the weights as fractions
 * (0.35 ...). The server uses whole percents (35 ...) and must give the same numbers.
 */
const FRONTEND_STANDARD: Array<{ name: string; metrics: MetricValues; v2: number; v1: number; band: string }> = [
  { name: 'a', metrics: { quality: 86, onTime: 80, completion: 90, rework: 20, attendance: 95 }, v2: 85.6, v1: 85.9, band: 'excellent' },
  { name: 'b', metrics: { quality: 100, onTime: 100, completion: 100, rework: 0, attendance: 100 }, v2: 100, v1: 100, band: 'excellent' },
  { name: 'c', metrics: { quality: 0, onTime: 0, completion: 0, rework: 100, attendance: 0 }, v2: 0, v1: 0, band: 'poor' },
  { name: 'd', metrics: { quality: 72.5, onTime: 66.7, completion: 83.3, rework: 33.3, attendance: 91.4 }, v2: 74.5, v1: 74.8, band: 'good' },
  { name: 'e', metrics: { quality: 84, onTime: 85, completion: 85, rework: 15, attendance: 85 }, v2: 84.7, v1: 84.6, band: 'good' },
];

describe('bandOf (85 / 70 / 50 edges, same as the frontend)', () => {
  it.each([
    [0, 'poor'],
    [49.9, 'poor'],
    [50, 'needs_improvement'],
    [69.9, 'needs_improvement'],
    [70, 'good'],
    [84.9, 'good'],
    [85, 'excellent'],
    [100, 'excellent'],
  ])('%s is %s', (score, band) => {
    expect(bandOf(score)).toBe(band);
  });
});

describe('computeScore with a complete set of metrics', () => {
  it('is the plan formula: 0.35 Q + 0.25 T + 0.20 C + 0.10 (100 - R) + 0.10 A', () => {
    // 0.35 x 86 + 0.25 x 80 + 0.20 x 90 + 0.10 x 80 + 0.10 x 95 = 30.1 + 20 + 18 + 8 + 9.5
    expect(computeScore('standard', { quality: 86, onTime: 80, completion: 90, rework: 20, attendance: 95 }, STANDARD)).toBe(85.6);
  });

  it.each(FRONTEND_STANDARD)('gives the frontend number for set $name (weights v2 and v1)', ({ metrics, v2, v1, band }) => {
    expect(computeScore('standard', metrics, STANDARD)).toBe(v2);
    expect(computeScore('standard', metrics, STANDARD_V1)).toBe(v1);
    expect(bandOf(v2)).toBe(band);
  });

  it('keeps each metric within 0 to 100 (rework is 100 minus R)', () => {
    expect(computeScore('standard', { quality: 150, onTime: 100, completion: 100, rework: 0, attendance: 100 }, STANDARD)).toBe(100);
    expect(computeScore('standard', { quality: -20, onTime: 0, completion: 0, rework: 100, attendance: 0 }, STANDARD)).toBe(0);
  });

  it('uses the sales weights for the sales kind (V, M, W, D, A)', () => {
    // frontend: salesMetrics(good) with attendance 94.04 -> 85.7 / 87.5 / 80 / 100 / 94 -> score 87.1
    expect(computeScore('sales', { activity: 85.7, meetings: 87.5, won: 80, dataQuality: 100, attendance: 94 }, SALES)).toBe(87.1);
    expect(computeScore('sales', { activity: 61.9, meetings: 50, won: 22.5, dataQuality: 79, attendance: 94 }, SALES)).toBe(53.6);
    expect(computeScore('sales', { activity: 100, meetings: 100, won: 100, dataQuality: 0, attendance: 94 }, SALES)).toBe(89.1);
  });
});

describe('computeScore when a metric cannot be measured (nothing is invented)', () => {
  const noAttendance: MetricValues = { quality: 86, onTime: 80, completion: 90, rework: 20, attendance: null };

  it('leaves the metric out and shares its weight among the measured ones', () => {
    // (35 x 86 + 25 x 80 + 20 x 90 + 10 x 80) / 90 = 84.555... -> 84.6
    expect(computeScore('standard', noAttendance, STANDARD)).toBe(84.6);
  });

  it('is the same as a missing key', () => {
    expect(computeScore('standard', { quality: 86, onTime: 80, completion: 90, rework: 20 }, STANDARD)).toBe(84.6);
  });

  it('a person with every measured metric at 100 still gets 100 (no penalty for the missing one)', () => {
    expect(computeScore('standard', { quality: 100, onTime: 100, completion: 100, rework: 0, attendance: null }, STANDARD)).toBe(100);
  });

  it('is null when nothing at all was measured', () => {
    expect(computeScore('standard', { quality: null, onTime: null, completion: null, rework: null, attendance: null }, STANDARD)).toBeNull();
    expect(computeScore('sales', {}, SALES)).toBeNull();
  });

  it('is null when the measured metrics carry no weight', () => {
    expect(computeScore('standard', { quality: 80, onTime: null, completion: null, rework: null, attendance: null }, { quality: 0, onTime: 40, completion: 30, rework: 20, attendance: 10 })).toBeNull();
  });

  it('shares the weights so they add up to 1 over the measured metrics', () => {
    const rows = contributions('standard', noAttendance, STANDARD);
    expect(rows.filter((r) => r.measured).reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1, 10);
    const attendance = rows.find((r) => r.key === 'attendance');
    expect(attendance).toMatchObject({ raw: null, used: null, weight: 0, points: null, measured: false });
  });
});

describe('contributions', () => {
  it('lists the five metrics of the kind in order with weight as a fraction', () => {
    const rows = contributions('standard', { quality: 86, onTime: 80, completion: 90, rework: 20, attendance: 95 }, STANDARD);
    expect(rows.map((r) => r.key)).toEqual(['quality', 'onTime', 'completion', 'rework', 'attendance']);
    expect(rows.map((r) => r.weight)).toEqual([0.35, 0.25, 0.2, 0.1, 0.1]);
    expect(rows.find((r) => r.key === 'rework')).toMatchObject({ raw: 20, used: 80, points: 8 });
    expect(rows.reduce((s, r) => s + (r.points ?? 0), 0)).toBeCloseTo(85.6, 5);
  });

  it('names the sales metrics for a sales scorecard', () => {
    expect(metricKeys('sales')).toEqual(['activity', 'meetings', 'won', 'dataQuality', 'attendance']);
  });
});

describe('validateWeights', () => {
  it('accepts the starting weights of both kinds', () => {
    expect(validateWeights('standard', STANDARD)).toEqual({ ok: true });
    expect(validateWeights('sales', SALES)).toEqual({ ok: true });
  });

  it('refuses a set that does not add up to exactly 100', () => {
    expect(validateWeights('standard', { ...STANDARD, quality: 34 })).toMatchObject({ ok: false, code: 'weights_sum', message: 'Weights must add up to 100% (now 99%).' });
    expect(validateWeights('standard', { ...STANDARD, quality: 36 })).toMatchObject({ ok: false, code: 'weights_sum' });
  });

  it('refuses fractions, negatives and weights above 100', () => {
    expect(validateWeights('standard', { ...STANDARD, quality: 34.5, onTime: 25.5 })).toMatchObject({ ok: false, code: 'weights_whole' });
    expect(validateWeights('standard', { quality: 110, onTime: -10, completion: 0, rework: 0, attendance: 0 })).toMatchObject({ ok: false, code: 'weights_range' });
    expect(validateWeights('standard', { ...STANDARD, quality: '35' })).toMatchObject({ ok: false, code: 'weights_whole' });
  });

  it('refuses a wrong set of metric names (a sales set for the standard kind, a missing or an extra key)', () => {
    expect(validateWeights('standard', SALES)).toMatchObject({ ok: false, code: 'weights_keys' });
    expect(validateWeights('standard', { quality: 50, onTime: 50 })).toMatchObject({ ok: false, code: 'weights_keys' });
    expect(validateWeights('standard', { ...STANDARD, bonus: 0 })).toMatchObject({ ok: false, code: 'weights_keys' });
  });

  it('allows a weight of 0 (a metric the Director does not want to count)', () => {
    expect(validateWeights('standard', { quality: 50, onTime: 30, completion: 20, rework: 0, attendance: 0 })).toEqual({ ok: true });
  });
});

describe('units and labels', () => {
  it('converts whole percents to the fractions the performance screens use', () => {
    expect(percentsToFractions(STANDARD)).toEqual({ quality: 0.35, onTime: 0.25, completion: 0.2, rework: 0.1, attendance: 0.1 });
  });

  it('labels a version', () => {
    expect(weightsLabel('standard', 2)).toBe('Standard v2');
    expect(weightsLabel('sales', 1)).toBe('Sales v1');
  });

  it('rounds to one decimal like the frontend', () => {
    expect(round1(84.555)).toBe(84.6);
    expect(round1(76.43)).toBe(76.4);
  });
});

/**
 * Exact ties (a score that is exactly x.x5) used to round either way, by float noise, when a metric was missing and the weights
 * were scaled (attendance is missing for every standard scorecard until Module 7). One sum, one division, one half-up rounding:
 * the expected values are the exact quotients (4045.5 / 90 = 44.95 and so on), and the frontend's logic.ts must give the same.
 */
describe('computeScore on exact ties (half up, the same on the server and in the frontend logic)', () => {
  it.each([
    // [name, kind, metrics, weights, exact quotient shown as a comment, expected]
    ['standard, attendance missing, 4045.5 / 90 = 44.95', 'standard', { quality: 0.1, onTime: 75, completion: 66.7, rework: 16.7, attendance: null }, STANDARD, 45],
    ['standard, attendance missing, 4531.5 / 90 = 50.35', 'standard', { quality: 86.3, onTime: 33.6, completion: 24.1, rework: 81.1, attendance: null }, STANDARD, 50.4],
    ['standard, attendance missing, 6862.5 / 90 = 76.25', 'standard', { quality: 98.5, onTime: 87.2, completion: 51.9, rework: 80.3, attendance: null }, STANDARD, 76.3],
    ['standard, attendance missing, 5980.5 / 90 = 66.45', 'standard', { quality: 42.3, onTime: 73.6, completion: 92.3, rework: 18.6, attendance: null }, STANDARD, 66.5],
    ['sales, only V, W, D measured, 3099 / 60 = 51.65', 'sales', { activity: 27.6, won: 74.8, dataQuality: 30.3, meetings: null, attendance: null }, SALES, 51.7],
  ] as const)('%s', (_name, kind, metrics, weights, expected) => {
    expect(computeScore(kind, metrics as MetricValues, weights)).toBe(expected);
  });

  it('a tie on a band edge goes to the higher band: 84.95 is 85 (Excellent), 69.95 is 70 (Good), 49.95 is 50 (Needs improvement)', () => {
    const half = { quality: 50, onTime: 50, completion: 0, rework: 0, attendance: 0 };
    const at = (a: number, b: number) => computeScore('standard', { quality: a, onTime: b, completion: null, rework: null, attendance: null }, half) as number;
    expect(at(84.9, 85)).toBe(85); // (84.9 + 85) / 2 = 84.95
    expect(bandOf(at(84.9, 85))).toBe('excellent');
    expect(at(69.9, 70)).toBe(70);
    expect(bandOf(at(69.9, 70))).toBe('good');
    expect(at(49.9, 50)).toBe(50);
    expect(bandOf(at(49.9, 50))).toBe('needs_improvement');
  });

  it('roundScore rounds a tie up and leaves every other number alone', () => {
    expect(roundScore(44.95)).toBe(45);
    expect(roundScore(76.25)).toBe(76.3);
    expect(roundScore(84.9499)).toBe(84.9);
    expect(roundScore(84.9501)).toBe(85);
    expect(roundScore(0)).toBe(0);
    expect(roundScore(100)).toBe(100);
  });

  it('matches an exact integer calculation on 20,000 random sets (full and partial, standard and sales)', () => {
    // A small deterministic generator, so a failure can be repeated.
    let seed = 20261118;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const tenths = (): number => Math.floor(next() * 1001); // 0.0 to 100.0 in tenths
    const sets: Array<{ kind: 'standard' | 'sales'; weights: Record<string, number> }> = [
      { kind: 'standard', weights: STANDARD },
      { kind: 'standard', weights: STANDARD_V1 },
      { kind: 'sales', weights: SALES },
      { kind: 'standard', weights: { quality: 50, onTime: 30, completion: 20, rework: 0, attendance: 0 } },
    ];
    for (let i = 0; i < 20000; i++) {
      const { kind, weights } = sets[i % sets.length];
      const keys = metricKeys(kind);
      const metrics: Record<string, number | null> = {};
      const usedTenths: Record<string, number> = {};
      for (const key of keys) {
        if (next() < 0.25) {
          metrics[key] = null;
          continue;
        }
        const t = tenths();
        metrics[key] = t / 10;
        usedTenths[key] = key === 'rework' ? 1000 - t : t;
      }
      const measured = Object.keys(usedTenths);
      let expected: number | null;
      if (measured.length === 0) expected = null;
      else {
        const all = measured.length === keys.length;
        const total = measured.reduce((s, k) => s + weights[k], 0);
        if (!all && total <= 0) expected = null;
        else {
          const w = all ? 100 : total;
          const s = measured.reduce((sum, k) => sum + usedTenths[k] * weights[k], 0); // whole numbers
          expected = Math.floor((2 * s + w) / (2 * w)) / 10; // half up, in tenths
        }
      }
      expect(computeScore(kind, metrics as MetricValues, weights), `${kind} ${JSON.stringify(metrics)}`).toBe(expected);
    }
  });
});
