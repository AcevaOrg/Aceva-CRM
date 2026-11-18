import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { outboxEventSchema, STANDARD_METRIC_KEYS, SALES_METRIC_KEYS } from '@aceva/contracts';
import { describe, expect, it } from 'vitest';
import {
  acknowledgedPayload,
  currentTasks,
  disputeDecidedPayload,
  disputeRaisedPayload,
  draftedPayload,
  figureTasksOf,
  releasedPayload,
  refusal,
  scorecardCreateData,
  scorecardTarget,
  toDisputeView,
  toMetricsView,
  toPerformanceWeightsView,
  toScorecardView,
  toWeightsView,
  weightsCreatedPayload,
  type DisputeRow,
  type ScorecardRow,
  type WeightsRow,
} from './performance-data';
import { buildFigures } from './rules/perf-figures';
import { SALES_METRIC_KEYS as RULE_SALES_KEYS, STANDARD_METRIC_KEYS as RULE_STANDARD_KEYS } from './rules/perf-score';

const ids = () => ({ card: randomUUID(), task1: randomUUID(), task2: randomUUID(), version: randomUUID(), dispute: randomUUID() });
const D = (n: number) => ({ toString: () => String(n), valueOf: () => n }) as never; // a Prisma Decimal for these tests
const at = (iso: string) => new Date(iso);

function cardRow(over: Partial<Record<string, unknown>> = {}): ScorecardRow {
  const i = ids();
  const base = {
    id: i.card,
    employeeId: 'e1',
    month: '2026-10',
    kind: 'standard',
    weightsVersionId: i.version,
    metrics: { quality: 81.4, onTime: 80, completion: 100, rework: 20, attendance: null, workloadHours: 12 },
    salesDetail: null,
    unmeasured: [{ key: 'attendance', reason: 'attendance_not_available' }],
    score: D(85),
    band: 'excellent',
    taskCount: 5,
    smallSample: false,
    status: 'released',
    reviewerId: 'r1',
    releasedAt: at('2026-11-02T09:00:00Z'),
    releasedById: 'r1',
    acknowledgedAt: null,
    recomputeCount: 0,
    createdAt: at('2026-10-31T19:10:00Z'),
    updatedAt: at('2026-11-02T09:00:00Z'),
    employee: { empId: 'ACV-0007' },
    reviewer: { empId: 'ACV-0004' },
    releasedBy: { empId: 'ACV-0004' },
    tasks: [
      { id: 's1', scorecardId: i.card, taskId: i.task1, position: 0, number: 'TSK-0101', title: 'Login screen', size: 'M', points: 3, rating: 3, onTime: true, reworked: false, extensions: 0, status: 'approved', counted: true, deadline: at('2026-10-10T08:00:00Z') },
      { id: 's2', scorecardId: i.card, taskId: i.task2, position: 1, number: 'TSK-0102', title: 'Cancelled work', size: 'S', points: 2, rating: null, onTime: false, reworked: false, extensions: 1, status: 'cancelled', counted: false, deadline: at('2026-10-12T08:00:00Z') },
    ],
    comments: [
      { id: 'c1', scorecardId: i.card, kind: 'reviewer_remark', authorId: 'r1', body: 'Steady month.', createdAt: at('2026-11-01T10:00:00Z'), author: { empId: 'ACV-0004' } },
      { id: 'c2', scorecardId: i.card, kind: 'reviewer_remark', authorId: 'r1', body: 'Please raise blockers earlier.', createdAt: at('2026-11-02T08:00:00Z'), author: { empId: 'ACV-0004' } },
      { id: 'c3', scorecardId: i.card, kind: 'employee_comment', authorId: 'e1', body: 'Thanks.', createdAt: at('2026-11-03T08:00:00Z'), author: { empId: 'ACV-0007' } },
    ],
    disputes: [],
    ...over,
  };
  return base as unknown as ScorecardRow;
}

describe('the keys the contracts, the rules and the database agree on', () => {
  it('the metric keys in the contracts are the ones the rules use', () => {
    expect([...STANDARD_METRIC_KEYS]).toEqual([...RULE_STANDARD_KEYS]);
    expect([...SALES_METRIC_KEYS]).toEqual([...RULE_SALES_KEYS]);
  });
});

describe('toScorecardView', () => {
  it('maps a released scorecard: score as a number, the newest remark and the employee comment, the stored reviewer, every task', () => {
    const v = toScorecardView(cardRow());
    expect(v).toMatchObject({
      empId: 'ACV-0007',
      month: '2026-10',
      kind: 'standard',
      score: 85,
      band: 'excellent',
      status: 'released',
      taskCount: 5,
      smallSample: false,
      reviewerEmpId: 'ACV-0004',
      reviewerRemark: 'Please raise blockers earlier.',
      remarkAt: '2026-11-02T08:00:00.000Z',
      employeeComment: 'Thanks.',
      releasedAt: '2026-11-02T09:00:00.000Z',
      releasedBy: 'ACV-0004',
      recomputeCount: 0,
      createdAt: '2026-10-31T19:10:00.000Z',
    });
    expect(v.metrics).toEqual({ quality: 81.4, onTime: 80, completion: 100, rework: 20, attendance: null, workloadHours: 12 });
    expect(v.unmeasured).toEqual([{ key: 'attendance', reason: 'attendance_not_available' }]);
    expect(v.tasks.map((t) => [t.number, t.rating, t.counted, t.status])).toEqual([
      ['TSK-0101', 3, true, 'approved'],
      ['TSK-0102', undefined, false, 'cancelled'],
    ]);
  });

  it('a scorecard with no score has score and band null (never a made-up number)', () => {
    const v = toScorecardView(cardRow({ score: null, band: null, metrics: { quality: null, onTime: null, completion: null, rework: null, attendance: null, workloadHours: 0 } }));
    expect(v.score).toBeNull();
    expect(v.band).toBeNull();
    expect(v.metrics).toMatchObject({ quality: null, attendance: null, workloadHours: 0 });
  });

  it('the Director scorecard has no reviewer and was released by the system', () => {
    const v = toScorecardView(cardRow({ reviewer: null, reviewerId: null, releasedBy: null, releasedById: null }));
    expect(v.reviewerEmpId).toBeUndefined();
    expect(v.releasedBy).toBeUndefined();
  });

  it('the services can name the reviewer NOW (the next level up when the manager left), or none', () => {
    expect(toScorecardView(cardRow(), { reviewerEmpId: 'ACV-0003' }).reviewerEmpId).toBe('ACV-0003');
    expect(toScorecardView(cardRow(), { reviewerEmpId: null }).reviewerEmpId).toBeUndefined();
  });

  it('a sales scorecard has the sales metrics and its raw figures', () => {
    const detail = { targetDaysMet: 18, workingDays: 21, meetings: 7, meetingTarget: 8, wonValueUsd: 3200, wonTargetUsd: 4000, bounceRate: 2.4, duplicates: 0 };
    const v = toScorecardView(cardRow({ kind: 'sales', metrics: { activity: 85.7, meetings: 87.5, won: 80, dataQuality: 100, attendance: null }, salesDetail: detail, tasks: [] }));
    expect(v.metrics).toEqual({ activity: 85.7, meetings: 87.5, won: 80, dataQuality: 100, attendance: null });
    expect(v.salesDetail).toEqual(detail);
  });

  it('shows the rating a dispute CHANGED, and keeps the original next to it', () => {
    const i = ids();
    const row = cardRow({
      tasks: [{ id: 's1', scorecardId: i.card, taskId: i.task1, position: 0, number: 'TSK-0101', title: 'Login screen', size: 'M', points: 3, rating: 3, onTime: true, reworked: false, extensions: 0, status: 'approved', counted: true, deadline: at('2026-10-10T08:00:00Z') }],
      disputes: [
        { taskId: i.task1, newRating: 4, decidedAt: at('2026-11-05T10:00:00Z') },
        { taskId: i.task1, newRating: 5, decidedAt: at('2026-11-09T10:00:00Z') },
      ],
    });
    expect(toScorecardView(row).tasks[0]).toMatchObject({ rating: 5, originalRating: 3 });
    expect(currentTasks(row)[0]).toMatchObject({ rating: 5, originalRating: 3 });
    // and as rule input for the recompute, including a change that is being decided right now
    const tasks = figureTasksOf(row, [{ taskId: i.task1, newRating: 2, decidedAt: at('2026-11-10T10:00:00Z') }]);
    expect(tasks[0]).toMatchObject({ rating: 2, counted: true, status: 'approved', points: 3 });
  });
});

describe('scorecardCreateData (what the monthly job inserts)', () => {
  const figures = buildFigures({
    kind: 'standard',
    tasks: [{ taskId: randomUUID(), number: 'TSK-0101', title: 'Login screen', size: 'M', points: 3, rating: 4, onTime: true, reworked: false, extensions: 0, status: 'approved', deadline: at('2026-10-10T08:00:00Z') }],
    now: at('2026-10-31T19:10:00Z'),
    attendance: null,
    sales: null,
    workloadHours: 8,
    weights: { quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10 },
  });
  const base = { employeeId: 'e1', month: '2026-10', weightsVersionId: randomUUID(), figures, now: at('2026-10-31T19:10:00Z') };

  it('a draft for a person with a reviewer', () => {
    const data = scorecardCreateData({ ...base, reviewerId: 'r1', autoRelease: false });
    expect(data).toMatchObject({ employeeId: 'e1', month: '2026-10', kind: 'standard', status: 'draft', reviewerId: 'r1', releasedAt: null, releasedById: null, taskCount: 1, smallSample: true, score: 92.2, band: 'excellent' });
    expect(data.unmeasured).toEqual([{ key: 'attendance', reason: 'attendance_not_available' }]);
    const tasks = (data.tasks as { create: Array<Record<string, unknown>> }).create;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ position: 0, number: 'TSK-0101', rating: 4, counted: true, status: 'approved' });
  });

  it('the Director scorecard: no reviewer, released by the system at once', () => {
    const data = scorecardCreateData({ ...base, reviewerId: null, autoRelease: true });
    expect(data).toMatchObject({ status: 'released', reviewerId: null, releasedById: null });
    expect(data.releasedAt).toEqual(base.now);
  });
});

describe('toDisputeView', () => {
  const row = (over: Partial<Record<string, unknown>> = {}): DisputeRow =>
    ({
      id: randomUUID(),
      scorecardId: randomUUID(),
      taskId: randomUUID(),
      employeeId: 'e1',
      reason: 'The client changed the brief twice.',
      ratingAtRaise: 3,
      deciderId: 'd1',
      status: 'open',
      decidedById: null,
      decision: null,
      newRating: null,
      decidedAt: null,
      scoreBefore: null,
      scoreAfter: null,
      metricsBefore: null,
      metricsAfter: null,
      createdAt: at('2026-11-04T08:00:00Z'),
      employee: { empId: 'ACV-0007' },
      decider: { empId: 'ACV-0003' },
      decidedBy: null,
      scorecard: { month: '2026-10' },
      scorecardTask: { number: 'TSK-0101', title: 'Login screen' },
      ...over,
    }) as unknown as DisputeRow;

  it('maps an open dispute', () => {
    expect(toDisputeView(row())).toMatchObject({ empId: 'ACV-0007', taskNumber: 'TSK-0101', taskTitle: 'Login screen', currentRating: 3, status: 'open', deciderEmpId: 'ACV-0003', month: '2026-10', at: '2026-11-04T08:00:00.000Z' });
  });

  it('maps a decided one with the rating change and the score before and after', () => {
    const v = toDisputeView(row({ status: 'changed', decidedBy: { empId: 'ACV-0003' }, decision: 'Fair point.', newRating: 5, decidedAt: at('2026-11-05T10:00:00Z'), scoreBefore: D(81.5), scoreAfter: D(85.2) }));
    expect(v).toMatchObject({ status: 'changed', decidedBy: 'ACV-0003', decision: 'Fair point.', newRating: 5, scoreBefore: 81.5, scoreAfter: 85.2 });
  });
});

describe('toWeightsView', () => {
  it('serves whole percents, a label and who saved it (null = the starting version)', () => {
    const row = { id: randomUUID(), kind: 'standard', departmentId: null, versionNo: 2, weights: { quality: 40, onTime: 20, completion: 20, rework: 10, attendance: 10 }, note: 'Quality first', effectiveFrom: at('2026-11-10T08:00:00Z'), createdAt: at('2026-11-10T08:00:00Z'), createdById: 'd1', createdBy: { empId: 'ACV-0003' }, department: null } as unknown as WeightsRow;
    expect(toWeightsView(row)).toMatchObject({ label: 'Standard v2', kind: 'standard', weights: { quality: 40, onTime: 20, completion: 20, rework: 10, attendance: 10 }, versionNo: 2, createdBy: 'ACV-0003', note: 'Quality first', departmentId: undefined });
    expect(toWeightsView({ ...row, createdBy: null, createdById: null, note: null, kind: 'sales', versionNo: 1, department: { name: 'Sales' }, departmentId: 'dep' } as unknown as WeightsRow)).toMatchObject({ label: 'Sales v1', createdBy: null, note: undefined, departmentName: 'Sales', departmentId: 'dep' });
  });
});

describe('scorecardTarget', () => {
  it('is one readable key for every audit entry of a scorecard: the Emp-ID and the month', () => {
    expect(scorecardTarget({ month: '2026-10', employee: { empId: 'ACV-0006' } })).toBe('ACV-0006 2026-10');
  });
});

describe('toPerformanceWeightsView (what every employee gets with their live figures and scorecards)', () => {
  it('has the set and its label, but never who saved it or the Director\'s reason', () => {
    const row = { id: randomUUID(), kind: 'standard', departmentId: 'dep', versionNo: 3, weights: { quality: 40, onTime: 20, completion: 20, rework: 10, attendance: 10 }, note: 'Deadlines matter more', effectiveFrom: at('2026-11-10T08:00:00Z'), createdAt: at('2026-11-10T08:00:00Z'), createdById: 'd1', createdBy: { empId: 'ACV-0003' }, department: { name: 'Development' } } as unknown as WeightsRow;
    const view = toPerformanceWeightsView(row);
    expect(view).toEqual({ id: row.id, label: 'Standard v3', kind: 'standard', departmentId: 'dep', departmentName: 'Development', weights: { quality: 40, onTime: 20, completion: 20, rework: 10, attendance: 10 }, versionNo: 3, effectiveFrom: '2026-11-10T08:00:00.000Z' });
    expect(Object.keys(view)).not.toContain('note');
    expect(Object.keys(view)).not.toContain('createdBy');
    expect(JSON.stringify(view)).not.toContain('Deadlines matter more');
    // the Settings list still carries both
    expect(toWeightsView(row)).toMatchObject({ createdBy: 'ACV-0003', note: 'Deadlines matter more' });
  });
});

describe('the answers a refusal turns into', () => {
  it('403, 409 and 400 with the rule code and message', () => {
    expect(refusal({ ok: false, kind: 'forbidden', code: 'not_reviewer', message: 'View only.' })).toBeInstanceOf(ForbiddenException);
    expect(refusal({ ok: false, kind: 'conflict', code: 'already_decided', message: 'Done.' })).toBeInstanceOf(ConflictException);
    const bad = refusal({ ok: false, kind: 'invalid', code: 'not_rated', message: 'Choose a rated task.' });
    expect(bad).toBeInstanceOf(BadRequestException);
    expect(bad.getResponse()).toEqual({ statusCode: 400, code: 'not_rated', message: 'Choose a rated task.' });
  });
});

describe('every event payload builder makes a payload the contract accepts', () => {
  const base = { id: randomUUID(), version: 1, occurredAt: '2026-11-17T10:00:00.000Z' };
  const row = cardRow();
  const disputeRow = (status: 'open' | 'changed' | 'upheld') =>
    ({
      id: randomUUID(),
      scorecardId: randomUUID(),
      taskId: randomUUID(),
      ratingAtRaise: 3,
      status,
      newRating: status === 'changed' ? 5 : null,
      scoreBefore: status === 'changed' ? D(81.5) : null,
      scoreAfter: status === 'changed' ? D(85.2) : null,
      employee: { empId: 'ACV-0007' },
      decider: { empId: 'ACV-0003' },
      decidedBy: status === 'open' ? null : { empId: 'ACV-0003' },
      scorecard: { month: '2026-10' },
      scorecardTask: { number: 'TSK-0101', title: 'Login screen' },
    }) as unknown as DisputeRow;

  it('scorecard.drafted, scorecard.released, scorecard.acknowledged', () => {
    expect(outboxEventSchema.safeParse({ ...base, type: 'scorecard.drafted', actor: 'system', payload: draftedPayload(row, 'ACV-0004') }).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...base, type: 'scorecard.drafted', actor: 'system', payload: draftedPayload(cardRow({ score: null, band: null }), null) }).success).toBe(true);
    const manual = releasedPayload(row, 'ACV-0004', true);
    expect(manual).toMatchObject({ releasedBy: 'ACV-0004', automatic: false, hasRemark: true });
    expect(outboxEventSchema.safeParse({ ...base, type: 'scorecard.released', actor: 'ACV-0004', payload: manual }).success).toBe(true);
    const auto = releasedPayload(row, null, false);
    expect(auto).toMatchObject({ releasedBy: null, automatic: true });
    expect(outboxEventSchema.safeParse({ ...base, type: 'scorecard.released', actor: 'system', payload: auto }).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...base, type: 'scorecard.acknowledged', actor: 'ACV-0007', payload: acknowledgedPayload(row, 'ACV-0004', false) }).success).toBe(true);
  });

  it('scorecard.dispute_raised and scorecard.dispute_decided (kept and changed)', () => {
    expect(outboxEventSchema.safeParse({ ...base, type: 'scorecard.dispute_raised', actor: 'ACV-0007', payload: disputeRaisedPayload(disputeRow('open')) }).success).toBe(true);
    const changed = disputeDecidedPayload(disputeRow('changed'));
    expect(changed).toMatchObject({ decision: 'changed', ratingBefore: 3, ratingAfter: 5, scoreBefore: 81.5, scoreAfter: 85.2 });
    expect(outboxEventSchema.safeParse({ ...base, type: 'scorecard.dispute_decided', actor: 'ACV-0003', payload: changed }).success).toBe(true);
    const upheld = disputeDecidedPayload(disputeRow('upheld'));
    expect(upheld).toMatchObject({ decision: 'upheld', ratingAfter: null, scoreBefore: null, scoreAfter: null });
    expect(outboxEventSchema.safeParse({ ...base, type: 'scorecard.dispute_decided', actor: 'ACV-0003', payload: upheld }).success).toBe(true);
  });

  it('score_weights.created', () => {
    const w = { id: randomUUID(), kind: 'sales', departmentId: null, versionNo: 2, weights: { activity: 20, meetings: 25, won: 30, dataQuality: 10, attendance: 15 } } as unknown as WeightsRow;
    expect(outboxEventSchema.safeParse({ ...base, type: 'score_weights.created', actor: 'ACV-0003', payload: weightsCreatedPayload(w, randomUUID()) }).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...base, type: 'score_weights.created', actor: 'ACV-0003', payload: weightsCreatedPayload(w, null) }).success).toBe(true);
  });
});

describe('toMetricsView', () => {
  it('missing or non-numeric stored values are null, workload defaults to 0', () => {
    expect(toMetricsView('standard', { quality: 90 })).toEqual({ quality: 90, onTime: null, completion: null, rework: null, attendance: null, workloadHours: 0 });
    expect(toMetricsView('sales', { activity: 'x' } as never)).toEqual({ activity: null, meetings: null, won: null, dataQuality: null, attendance: null });
  });
});
