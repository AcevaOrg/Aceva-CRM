/**
 * One person's figures for one month, from the facts about their tasks (and the attendance and sales sources), and the
 * recompute after a dispute changed a rating. Pure functions: no Nest, no database.
 *
 * Used by the live figures (this month so far), by the monthly job (a closed month, stored as a draft scorecard) and by
 * the dispute decision. All three call the same functions, so they can never disagree.
 *
 * NOTHING IS INVENTED. A metric nobody can measure is null and is named in `unmeasured` with the reason:
 *   attendance_not_available  Module 7 (attendance) does not exist yet
 *   sales_not_available       Module 15 (sales and CRM) does not exist yet; a sales scorecard has no score without it
 *   nothing_to_measure        no counted task gives this metric a value this month (for example no rated task)
 */
import { bandOf, computeScore, SMALL_SAMPLE, round1, type Band, type MetricKey, type MetricValues, type ScorecardKind, type Weights } from './perf-score';
import { countsForMetrics, salesMetrics, taskMetrics, type SalesDetail, type ScorecardTaskFacts } from './perf-tasks';

export type UnmeasuredReason = 'attendance_not_available' | 'sales_not_available' | 'nothing_to_measure';
export interface Unmeasured {
  key: MetricKey;
  reason: UnmeasuredReason;
}

/** The metrics as stored on a scorecard and sent to the screens. workloadHours exists only for the standard kind. */
export type StoredMetrics = Partial<Record<MetricKey, number | null>> & { workloadHours?: number };

export interface MonthInputs {
  kind: ScorecardKind;
  /** Every non-personal task of the month (cancelled ones too), already mapped (toScorecardTask). Empty for sales. */
  tasks: readonly ScorecardTaskFacts[];
  /** The moment of measuring: decides which open tasks are already due. */
  now: Date;
  /** Attendance 0 to 100 from the attendance source; null = not available. */
  attendance: number | null;
  /** The sales numbers from the sales source; null = not available. */
  sales: SalesDetail | null;
  /** Open task hours now (information only). */
  workloadHours: number;
  /** The weights version's whole percentages. */
  weights: Weights;
}

export interface FigureTask extends ScorecardTaskFacts {
  /** This task took part in the metrics (not cancelled, already due or handed in). */
  counted: boolean;
}

export interface MonthFigures {
  kind: ScorecardKind;
  metrics: StoredMetrics;
  salesDetail: SalesDetail | null;
  unmeasured: Unmeasured[];
  /** Null when nothing could be measured. */
  score: number | null;
  band: Band | null;
  taskCount: number;
  /** Fewer than 5 tasks counted (standard scorecards only). */
  smallSample: boolean;
  tasks: FigureTask[];
}

const TASK_KEYS = ['quality', 'onTime', 'completion', 'rework'] as const;
const SALES_ONLY_KEYS = ['activity', 'meetings', 'won', 'dataQuality'] as const;

export function buildFigures(input: MonthInputs): MonthFigures {
  const unmeasured: Unmeasured[] = [];
  if (input.kind === 'sales') {
    const sm = input.sales ? salesMetrics(input.sales, input.attendance) : null;
    const metrics: StoredMetrics = {
      activity: sm?.activity ?? null,
      meetings: sm?.meetings ?? null,
      won: sm?.won ?? null,
      dataQuality: sm?.dataQuality ?? null,
      attendance: sm ? sm.attendance : input.attendance === null ? null : round1(input.attendance),
    };
    if (!input.sales) for (const key of SALES_ONLY_KEYS) unmeasured.push({ key, reason: 'sales_not_available' });
    if (metrics.attendance === null || metrics.attendance === undefined) unmeasured.push({ key: 'attendance', reason: 'attendance_not_available' });
    // A sales scorecard without the sales figures has no score: attendance alone says nothing about sales work.
    const score = input.sales ? computeScore('sales', metrics, input.weights) : null;
    return {
      kind: 'sales',
      metrics,
      salesDetail: input.sales,
      unmeasured,
      score,
      band: score === null ? null : bandOf(score),
      taskCount: input.sales?.workingDays ?? 0,
      smallSample: false,
      tasks: [],
    };
  }

  const tasks: FigureTask[] = input.tasks.map((t) => ({ ...t, counted: countsForMetrics(t, input.now) }));
  const tm = taskMetrics(tasks.filter((t) => t.counted));
  const metrics: StoredMetrics = {
    quality: tm.quality,
    onTime: tm.onTime,
    completion: tm.completion,
    rework: tm.rework,
    attendance: input.attendance === null ? null : round1(input.attendance),
    workloadHours: round1(input.workloadHours),
  };
  for (const key of TASK_KEYS) if (metrics[key] === null) unmeasured.push({ key, reason: 'nothing_to_measure' });
  if (metrics.attendance === null) unmeasured.push({ key: 'attendance', reason: 'attendance_not_available' });
  const score = computeScore('standard', metrics, input.weights);
  return {
    kind: 'standard',
    metrics,
    salesDetail: null,
    unmeasured,
    score,
    band: score === null ? null : bandOf(score),
    taskCount: tm.taskCount,
    smallSample: tm.taskCount < SMALL_SAMPLE,
    tasks,
  };
}

// ---------------------------------------------------------------------------------------------------------- recompute

/** A rating a decided "changed" dispute set for a task of the scorecard. */
export interface RatingChange {
  taskId: string;
  newRating: number;
  decidedAt: Date;
}

/**
 * The rating each task has now: the snapshot's rating, or the new rating of the LATEST changed dispute for that task.
 * Returns the tasks with their current rating, and the original rating when a dispute changed it.
 */
export function withCurrentRatings<T extends { taskId: string; rating: number | null }>(tasks: readonly T[], changes: readonly RatingChange[]): Array<T & { originalRating: number | null }> {
  const latest = new Map<string, RatingChange>();
  for (const c of changes) {
    const seen = latest.get(c.taskId);
    if (!seen || c.decidedAt.getTime() >= seen.decidedAt.getTime()) latest.set(c.taskId, c);
  }
  return tasks.map((t) => {
    const change = latest.get(t.taskId);
    return { ...t, rating: change ? change.newRating : t.rating, originalRating: change ? t.rating : null };
  });
}

export interface Rescored {
  metrics: StoredMetrics;
  score: number | null;
  band: Band | null;
}

/**
 * The numbers of a STANDARD scorecard after ratings changed, with the weights version it was made with. Only the task
 * metrics are worked out again, from the stored task list (the tasks that were counted, with their current ratings); the
 * attendance, the workload and the unmeasured list stay exactly as stored. A metric that is not measured stays not measured.
 * (A sales scorecard has no task ratings, so a dispute never reaches it.)
 */
export function rescoreStandard(stored: StoredMetrics, tasks: ReadonlyArray<ScorecardTaskFacts & { counted: boolean }>, weights: Weights): Rescored {
  const tm = taskMetrics(tasks.filter((t) => t.counted));
  const metrics: StoredMetrics = {
    ...stored,
    quality: stored.quality === null || stored.quality === undefined ? null : (tm.quality ?? stored.quality),
    onTime: stored.onTime === null || stored.onTime === undefined ? null : (tm.onTime ?? stored.onTime),
    completion: stored.completion === null || stored.completion === undefined ? null : (tm.completion ?? stored.completion),
    rework: stored.rework === null || stored.rework === undefined ? null : (tm.rework ?? stored.rework),
  };
  const score = computeScore('standard', metrics as MetricValues, weights);
  return { metrics, score, band: score === null ? null : bandOf(score) };
}
