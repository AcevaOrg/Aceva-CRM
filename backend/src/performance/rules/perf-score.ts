/**
 * Score weights, the overall score and the bands (plan section 10, spec 9.6). Pure functions: no Nest, no database.
 *
 *   Score       = 0.35 Q + 0.25 T + 0.20 C + 0.10 (100 - R) + 0.10 A          (the starting standard weights)
 *   Sales score = 0.20 V + 0.25 M + 0.30 W + 0.10 D + 0.15 A                    (plan section 20)
 *
 * The server keeps weights as WHOLE PERCENTAGES that add up to exactly 100 (35, 25, 20, 10, 10): exact, so the sum check
 * is exact. The formula uses them as fractions (35 / 100 is the same number as 0.35). The score is one sum of
 * metric x whole percent, divided once and rounded half up once (computeScore / roundScore), and the frontend's mock logic
 * (frontend/src/features/performance/logic.ts) works it out the same way, so the same input gives the same number on both
 * sides, for a partial set of metrics too; the unit test copies that logic's own outputs and checks random sets against an
 * exact integer calculation.
 *
 * A metric that could not be measured (nobody to measure it yet) is null and is LEFT OUT of the score: the weights of the
 * measured metrics are scaled up to share 100 (Score = sum(points of measured) / sum(weights of measured)). Nothing is
 * ever made up: Attendance (Module 7) and the sales figures (Module 15) are null until those modules exist. When nothing
 * at all is measured the score is null (no score, no band).
 */

export type ScorecardKind = 'standard' | 'sales';

export const STANDARD_METRIC_KEYS = ['quality', 'onTime', 'completion', 'rework', 'attendance'] as const;
export const SALES_METRIC_KEYS = ['activity', 'meetings', 'won', 'dataQuality', 'attendance'] as const;
export type StandardMetricKey = (typeof STANDARD_METRIC_KEYS)[number];
export type SalesMetricKey = (typeof SALES_METRIC_KEYS)[number];
export type MetricKey = StandardMetricKey | SalesMetricKey;

/** Weights by metric key, in whole percentages. */
export type Weights = Readonly<Record<string, number>>;
/** The metrics of a person and month: 0 to 100 each; null or missing = not measured. */
export type MetricValues = Readonly<Partial<Record<MetricKey, number | null>>>;

/** A month with fewer tasks than this shows the "small sample" note (plan section 10). */
export const SMALL_SAMPLE = 5;

/** Rework is the only metric where lower is better (the score uses 100 - R). */
export const LOWER_IS_BETTER: MetricKey = 'rework';

export const metricKeys = (kind: ScorecardKind): readonly MetricKey[] => (kind === 'sales' ? SALES_METRIC_KEYS : STANDARD_METRIC_KEYS);

export const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp100 = (n: number): number => Math.max(0, Math.min(100, n));
const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

// ---------------------------------------------------------------------------------------------------------- bands

export type Band = 'excellent' | 'good' | 'needs_improvement' | 'poor';

/** 85 to 100 Excellent, 70 to 84 Good, 50 to 69 Needs improvement, below 50 Poor (the edges belong to the higher band). */
export function bandOf(score: number): Band {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'needs_improvement';
  return 'poor';
}

export const BAND_LABEL: Record<Band, string> = {
  excellent: 'Excellent',
  good: 'Good',
  needs_improvement: 'Needs improvement',
  poor: 'Poor',
};

// ---------------------------------------------------------------------------------------------------------- weights

export type WeightsProblem = { ok: false; code: 'weights_keys' | 'weights_whole' | 'weights_range' | 'weights_sum'; message: string };

/**
 * A set of weights is valid when it names exactly the metrics of its kind, every weight is a whole number from 0 to 100
 * and they add up to exactly 100. (The database repeats this check.)
 */
export function validateWeights(kind: ScorecardKind, weights: Readonly<Record<string, unknown>>): { ok: true } | WeightsProblem {
  const keys = metricKeys(kind);
  const given = Object.keys(weights);
  if (given.length !== keys.length || !keys.every((k) => given.includes(k))) {
    return { ok: false, code: 'weights_keys', message: `The weights must be exactly: ${keys.join(', ')}.` };
  }
  for (const k of keys) {
    const w = weights[k];
    if (!isNumber(w) || !Number.isInteger(w)) return { ok: false, code: 'weights_whole', message: 'Each weight is a whole number of percent.' };
    if (w < 0 || w > 100) return { ok: false, code: 'weights_range', message: 'Each weight is between 0 and 100.' };
  }
  const total = keys.reduce((s, k) => s + (weights[k] as number), 0);
  if (total !== 100) return { ok: false, code: 'weights_sum', message: `Weights must add up to 100% (now ${total}%).` };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------- score

export interface Contribution {
  key: MetricKey;
  /** The metric as measured (null = not measured). */
  raw: number | null;
  /** What the score uses: 100 - R for rework, the value (kept within 0 to 100) for the others. Null = not measured. */
  used: number | null;
  /** The weight as a fraction of 1 (0.35), after the unmeasured metrics were left out and the rest scaled up. */
  weight: number;
  /** used x weight, one decimal. Null = not measured. */
  points: number | null;
  measured: boolean;
}

/** The share of the score each metric carries, with unmeasured metrics left out (see the file comment). */
export function contributions(kind: ScorecardKind, metrics: MetricValues, weights: Weights): Contribution[] {
  const keys = metricKeys(kind);
  const measured = keys.filter((k) => isNumber(metrics[k]));
  const measuredTotal = measured.reduce((s, k) => s + (weights[k] ?? 0), 0);
  const all = measured.length === keys.length;
  return keys.map((key) => {
    const raw = isNumber(metrics[key]) ? (metrics[key] as number) : null;
    if (raw === null) return { key, raw: null, used: null, weight: 0, points: null, measured: false };
    const used = key === LOWER_IS_BETTER ? 100 - raw : clamp100(raw);
    // A full set uses weight / 100 exactly like the frontend; a partial set shares 100 among the measured metrics.
    const weight = all ? (weights[key] ?? 0) / 100 : measuredTotal > 0 ? (weights[key] ?? 0) / measuredTotal : 0;
    return { key, raw, used, weight, points: round1(used * weight), measured: true };
  });
}

/**
 * Rounds a score to one decimal, HALF UP on an exact tie (84.95 gives 85, 44.95 gives 45). A score is a sum of products
 * divided by a whole number of percent, so an exact tie is common once a metric is left out and the weights are scaled
 * (4045.5 / 90 = 44.95); a plain Math.round(n * 10) then depends on float noise, so two ways of writing the same sum can
 * land on different sides of the tie. The nudge (1e-9) is far below the 0.01 that separates a real tie from the nearest
 * non-tie (the metrics have one decimal and the weights are whole percents), so it moves only ties, and always upward.
 * The frontend's logic.ts uses the same function so the mock screens and the server agree on every input.
 */
export const roundScore = (n: number): number => Math.round(n * 10 + 1e-9) / 10;

/**
 * The overall score 0 to 100 with one decimal, or null when no metric could be measured (or the measured ones carry no weight).
 * It is worked out as ONE sum over whole-percent weights, divided once: sum(used x weight in percent) / 100 for a full set, or
 * / the weights of the measured metrics for a partial set (the weights of the missing ones are shared out), then rounded
 * half up once (roundScore). Dividing each weight first (35 / 90) and summing fractions gave float noise at the ties.
 */
export function computeScore(kind: ScorecardKind, metrics: MetricValues, weights: Weights): number | null {
  const rows = contributions(kind, metrics, weights);
  const measured = rows.filter((r) => r.measured);
  if (measured.length === 0) return null;
  const all = measured.length === rows.length;
  const measuredTotal = measured.reduce((s, r) => s + (weights[r.key] ?? 0), 0);
  if (!all && measuredTotal <= 0) return null;
  const sum = measured.reduce((s, r) => s + (r.used as number) * (weights[r.key] ?? 0), 0);
  return roundScore(sum / (all ? 100 : measuredTotal));
}

// ---------------------------------------------------------------------------------------------------------- weights units

/** The frontend's performance screens use fractions (0.35); the server's canonical form is whole percents (35). */
export const percentsToFractions = (weights: Weights): Record<string, number> => Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, v / 100]));

/** "Standard v2" / "Sales v1" (a department's own set: "Standard v1"; the department is named next to it). */
export const weightsLabel = (kind: ScorecardKind, versionNo: number): string => `${kind === 'sales' ? 'Sales' : 'Standard'} v${versionNo}`;
