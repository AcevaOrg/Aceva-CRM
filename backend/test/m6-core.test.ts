import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityRecorder } from '../src/activity/activity-recorder.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { PerformanceCalculator } from '../src/performance/performance-calculator.service';
import { scorecardCreateData } from '../src/performance/performance-data';
import { monthOf, monthWindow, nextMonth, previousMonth } from '../src/performance/rules/perf-month';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 6 core (plan section 10): the scorecards (list, latest, detail, remark, release, acknowledge), who sees what, live
 * figures and the team table (sorted by name, never by score), rating disputes with the recompute that uses the weights version
 * the scorecard was made with, the rule that nobody can change the numbers, the approvals inbox items and the score weight
 * versions. The monthly job, the mails and the stand-in sources are in m6-automation.test.ts; the data layer rules are in
 * m6-foundation.test.ts.
 * Run on its own with: npm test -w backend -- m6-core
 *
 * The scorecards here are made the way the monthly job makes them (PerformanceCalculator + scorecardCreateData) from real task
 * rows, with weights version 1, so the numbers can be checked by hand:
 *   the "dispute card": tasks (points x rating) 3x2, 2x4, 5x3 (sent back once), 1x4, 3x5 (handed in late)
 *     quality 48 / 14 x 20 = 68.6, on time 4/5 = 80, completion 100, rework 1/5 = 20, attendance not available (Module 7)
 *     score (35 x 68.6 + 25 x 80 + 20 x 100 + 10 x 80) / 90 = 80.0 (Good)
 *     the first task changed from 2 to 5 stars: quality 57 / 14 x 20 = 81.4, score (35 x 81.4 + 4800) / 90 = 85.0 (Excellent)
 */
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const DEV3 = 'ACV-0008';
const SALES1 = 'ACV-0009';
const FINANCE = 'ACV-0010';
const SQA1 = 'ACV-0011';
const SQA2 = 'ACV-0013';

const API = '/api/v1';
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface TaskBody {
  taskId?: string;
  number: string;
  title: string;
  rating?: number;
  originalRating?: number;
  onTime: boolean;
  reworked: boolean;
  status: string;
  counted: boolean;
}
interface MetricsBody {
  quality?: number | null;
  onTime?: number | null;
  completion?: number | null;
  rework?: number | null;
  attendance?: number | null;
  workloadHours?: number;
  activity?: number | null;
  meetings?: number | null;
  won?: number | null;
  dataQuality?: number | null;
}
interface WeightsBody {
  id: string;
  label: string;
  kind: string;
  departmentId?: string;
  departmentName?: string;
  weights: Record<string, number>;
  versionNo: number;
  effectiveFrom: string;
  /** Only in the Settings list (settings.view): never with the live figures or a scorecard. */
  createdBy?: string | null;
  note?: string;
}
interface ScorecardBody {
  id: string;
  empId: string;
  month: string;
  kind: string;
  metrics: MetricsBody;
  unmeasured: Array<{ key: string; reason: string }>;
  weightsVersionId: string;
  score: number | null;
  band: string | null;
  taskCount: number;
  smallSample: boolean;
  status: string;
  reviewerEmpId?: string;
  reviewerRemark?: string;
  releasedBy?: string;
  releasedAt?: string;
  acknowledgedAt?: string;
  employeeComment?: string;
  recomputeCount: number;
  tasks: TaskBody[];
}
interface DisputeBody {
  id: string;
  scorecardId: string;
  empId: string;
  taskNumber: string;
  currentRating: number;
  reason: string;
  status: string;
  deciderEmpId: string;
  decidedBy?: string;
  decision?: string;
  newRating?: number;
  scoreBefore?: number;
  scoreAfter?: number;
  month: string;
}
interface DetailBody {
  scorecard: ScorecardBody;
  weights: WeightsBody;
  disputes: DisputeBody[];
  comments: Array<{ kind: string; author: string; body: string }>;
}
interface LiveBody {
  empId: string;
  month: string;
  kind: string;
  metrics: MetricsBody;
  unmeasured: Array<{ key: string; reason: string }>;
  weights: WeightsBody;
  score: number | null;
  band: string | null;
  taskCount: number;
  smallSample: boolean;
  trend: Array<{ month: string; score: number }>;
  tasks: TaskBody[];
}
interface TeamRow {
  empId: string;
  kind: string;
  latest: ScorecardBody | null;
  live: { score: number | null; band: string | null; smallSample: boolean };
  trend: Array<{ month: string; score: number }>;
}
interface ApprovalItem {
  id: string;
  type: string;
  refId: string;
  refNumber?: string;
  title: string;
  subtitle?: string;
  requester: string;
  href: string;
  needsRating?: boolean;
  approveLabel?: string;
  rejectLabel?: string;
  waitingFor?: string;
}

let t: TestApp;
let prisma: PrismaClient;
let calc: PerformanceCalculator;

// the months: M0 is the current one, M1 the month that just closed, and so on
let M0: string;
let M1: string;
let M2: string;
let M3: string;
let M4: string;

const get = (who: string | null, url: string) => t.as(who).get(`${API}${url}`);
const post = (who: string | null, url: string, body: Record<string, unknown> = {}) => t.as(who).post(`${API}${url}`).send(body);

const ids = new Map<string, string>();
async function eid(empId: string): Promise<string> {
  let id = ids.get(empId);
  if (!id) {
    id = (await prisma.employee.findUniqueOrThrow({ where: { empId }, select: { id: true } })).id;
    ids.set(empId, id);
  }
  return id;
}

const deadlineOf = (month: string, day: number): Date => new Date(monthWindow(month).start.getTime() + day * DAY + 8 * HOUR);

// ------------------------------------------------------------------------------------------------ fixtures

let taskSeq = 9000;
interface TaskSpec {
  points: number;
  rating?: number | null;
  late?: boolean;
  reworked?: boolean;
  status?: 'approved' | 'cancelled' | 'assigned';
  day?: number;
  reviewer?: string;
  title?: string;
  personal?: boolean;
  hours?: number;
}

/** A work task of `assignee` due in `month`, already approved with a rating by its reviewer (the CTO for developers, the Director for the CTO, the Owner for the Director). */
async function makeTask(assignee: string, month: string, spec: TaskSpec) {
  const reviewer = spec.reviewer ?? (assignee === DIRECTOR ? OWNER : assignee === CTO ? DIRECTOR : CTO);
  const status = spec.status ?? 'approved';
  const deadline = deadlineOf(month, spec.day ?? 10);
  const submittedAt = status === 'assigned' ? null : new Date(deadline.getTime() + (spec.late ? 2 : -2) * HOUR);
  const n = ++taskSeq;
  const row = await prisma.task.create({
    data: {
      number: spec.personal ? `TODO-${n}` : `TSK-${n}`,
      title: spec.title ?? `Work item ${n}`,
      assigneeId: await eid(assignee),
      assignedById: await eid(spec.personal ? assignee : reviewer),
      size: 'M',
      points: spec.points,
      estimatedHours: spec.hours ?? 4,
      startDate: new Date(deadline.getTime() - 3 * DAY),
      deadline,
      originalDeadline: deadline,
      status,
      personal: spec.personal ?? false,
      submittedAt,
      closedAt: status === 'assigned' ? null : submittedAt,
      reworkCount: spec.reworked ? 1 : 0,
    },
  });
  if (status === 'approved' && spec.rating) {
    await prisma.taskReview.create({
      data: { taskId: row.id, reviewerId: await eid(reviewer), decision: 'approved', rating: spec.rating, submittedAt, deadlineAtReview: deadline, createdAt: deadline },
    });
  }
  return row;
}

/** The five tasks of the dispute card (see the top of the file). */
const DISPUTE_TASKS: TaskSpec[] = [
  { points: 3, rating: 2, title: 'Disputed task' },
  { points: 2, rating: 4 },
  { points: 5, rating: 3, reworked: true },
  { points: 1, rating: 4 },
  { points: 3, rating: 5, late: true },
];
/** The same five tasks with other ratings: the foundation's worked example (quality 81.4, on time 80, completion 100, rework 20: 85). */
const LIVE_TASKS: TaskSpec[] = [
  { points: 3, rating: 5 },
  { points: 2, rating: 4, late: true },
  { points: 5, rating: 3, reworked: true },
  { points: 1, rating: 4 },
  { points: 3, rating: 5 },
];

let weightsV1: { standard: string; sales: string };

/**
 * A scorecard made the way the monthly job makes it: the calculator's figures from the person's real task rows, the weights
 * version 1, stored with the tasks it was made from. `status` released / acknowledged are reached by the real transitions.
 */
async function makeCard(emp: string, month: string, specs: TaskSpec[], opt: { status?: 'draft' | 'released' | 'acknowledged'; reviewer?: string | null; releasedBy?: string } = {}) {
  const person = await prisma.employee.findUniqueOrThrow({ where: { empId: emp }, select: { id: true, empId: true, departmentId: true, role: { select: { key: true } } } });
  const tasks: Array<Awaited<ReturnType<typeof makeTask>>> = [];
  for (const spec of specs) tasks.push(await makeTask(emp, month, spec));
  const kind = calc.kindOf(person.role.key);
  const weightsVersionId = weightsV1[kind];
  const now = t.clock.now();
  const { figures } = await calc.compute({ id: person.id, empId: person.empId, departmentId: person.departmentId, roleKey: person.role.key }, month, now, { weights: await calc.weightsById(weightsVersionId) });
  const reviewer = opt.reviewer === undefined ? (emp === DIRECTOR ? null : emp === CTO || kind === 'sales' || emp === FINANCE ? DIRECTOR : CTO) : opt.reviewer;
  const row = await prisma.scorecard.create({
    data: scorecardCreateData({ employeeId: person.id, month, weightsVersionId, reviewerId: reviewer ? await eid(reviewer) : null, figures, now, autoRelease: reviewer === null }),
  });
  const status = opt.status ?? 'draft';
  if (status !== 'draft' && reviewer) {
    await prisma.scorecard.update({ where: { id: row.id }, data: { status: 'released', releasedAt: now, releasedById: await eid(opt.releasedBy ?? reviewer) } });
  }
  if (status === 'acknowledged') await prisma.scorecard.update({ where: { id: row.id }, data: { status: 'acknowledged', acknowledgedAt: now } });
  return { id: row.id, tasks };
}

// the cards the tests use (filled in beforeAll)
let cardDev2Draft: { id: string; tasks: Array<{ id: string; number: string }> }; // C1: Dev2 M1, a draft
let cardDev2Released: { id: string; tasks: Array<{ id: string; number: string }> }; // C2: Dev2 M2
let cardDev1Draft: { id: string; tasks: Array<{ id: string; number: string }> }; // C3: Dev1 M1, a draft
let cardSalesDraft: { id: string; tasks: Array<{ id: string; number: string }> }; // C4: Hira M1, a sales draft
let cardCtoDraft: { id: string; tasks: Array<{ id: string; number: string }> }; // C5: the CTO M1, a draft (the Director reviews)
let cardDirector: { id: string; tasks: Array<{ id: string; number: string }> }; // C6: the Director M1, released by the system
let disputeCard: { id: string; tasks: Array<{ id: string; number: string }> }; // D1: Dev2 M3, released
let directorRatedCard: { id: string; tasks: Array<{ id: string; number: string }> }; // D2: Dev1 M3, a task rated by the Director
let dev3Card: { id: string; tasks: Array<{ id: string; number: string }> }; // E1: Dev3 M3, released
let weightsCard: { id: string; tasks: Array<{ id: string; number: string }> }; // W1: Dev1 M4, released

beforeAll(async () => {
  t = await createTestApp();
  prisma = createTestPrisma();
  await t.signInAll();
  calc = t.app.get(PerformanceCalculator);
  M0 = monthOf(t.clock.now());
  M1 = previousMonth(M0);
  M2 = previousMonth(M1);
  M3 = previousMonth(M2);
  M4 = previousMonth(M3);
  const v1 = await prisma.scoreWeightVersion.findMany({ where: { versionNo: 1, departmentId: null } });
  weightsV1 = { standard: v1.find((v) => v.kind === 'standard')!.id, sales: v1.find((v) => v.kind === 'sales')!.id };

  cardDev2Draft = await makeCard(DEV2, M1, LIVE_TASKS);
  cardDev2Released = await makeCard(DEV2, M2, LIVE_TASKS, { status: 'released' });
  cardDev1Draft = await makeCard(DEV1, M1, LIVE_TASKS);
  cardSalesDraft = await makeCard(SALES1, M1, []);
  cardCtoDraft = await makeCard(CTO, M1, LIVE_TASKS);
  cardDirector = await makeCard(DIRECTOR, M1, LIVE_TASKS);
  disputeCard = await makeCard(DEV2, M3, DISPUTE_TASKS, { status: 'released' });
  directorRatedCard = await makeCard(DEV1, M3, [{ points: 3, rating: 3, reviewer: DIRECTOR, title: 'Rated by the Director' }, ...LIVE_TASKS.slice(1)], { status: 'released' });
  dev3Card = await makeCard(DEV3, M3, [{ points: 2, rating: 3 }, { points: 2, rating: 4 }, { points: 2, rating: 5 }, { points: 2, rating: 4 }, { points: 2, rating: 4 }], { status: 'released' });
  weightsCard = await makeCard(DEV1, M4, [{ points: 2, rating: 2, title: 'Weights task' }, { points: 2, rating: 4 }], { status: 'released' });
}, 120000);

afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase(); // leave a clean, seeded database for the next test file
}, 120000);

async function eventsOf(type: string) {
  const rows = await prisma.outboxEvent.findMany({ where: { type }, orderBy: { occurredAt: 'asc' } });
  return rows.map((r) => ({ actor: r.actor, payload: r.payload as Record<string, unknown> }));
}
const auditOf = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { occurredAt: 'asc' } });

// ------------------------------------------------------------------------------------------------ the fixtures are what the tests assume

describe('the test scorecards are made like the monthly job makes them', () => {
  it('the dispute card has the hand-worked numbers: quality 68.6, on time 80, completion 100, rework 20, score 80 (Good)', async () => {
    const card = (await get(CTO, `/scorecards/${disputeCard.id}`).expect(200)).body as DetailBody;
    expect(card.scorecard.metrics).toMatchObject({ quality: 68.6, onTime: 80, completion: 100, rework: 20, attendance: null });
    expect(card.scorecard.score).toBe(80);
    expect(card.scorecard.band).toBe('good');
    expect(card.scorecard.taskCount).toBe(5);
    expect(card.scorecard.smallSample).toBe(false);
    expect(card.scorecard.unmeasured).toEqual([{ key: 'attendance', reason: 'attendance_not_available' }]);
  });
});

// ------------------------------------------------------------------------------------------------ who sees what

describe('visibility of scorecards', () => {
  it('the employee never gets a draft: not in the list, not as the latest, not by id', async () => {
    const mine = (await get(DEV2, '/scorecards').expect(200)).body as ScorecardBody[];
    expect(mine.map((s) => s.month)).toEqual([M2, M3]); // newest first; the M1 draft is not there
    expect(mine.every((s) => s.status !== 'draft')).toBe(true);
    const latest = (await get(DEV2, '/scorecards?latest=1').expect(200)).body as ScorecardBody[];
    expect(latest.map((s) => s.month)).toEqual([M2]);
    const res = await get(DEV2, `/scorecards/${cardDev2Draft.id}`).expect(404);
    expect(res.body.code).toBe('not_found');
  });

  it('a person without any released scorecard gets an empty list for latest, not a null body', async () => {
    const res = await get(SQA1, '/scorecards?latest=1').expect(200);
    expect(res.body).toEqual([]);
  });

  it('nobody sees a colleague beside them: 403 for a person, 404 for a scorecard', async () => {
    const res = await get(DEV1, `/scorecards?empId=${DEV2}`).expect(403);
    expect(res.body.code).toBe('forbidden');
    await get(DEV1, `/scorecards/${disputeCard.id}`).expect(404);
    await get(DEV1, `/performance/live?empId=${DEV2}`).expect(403);
    await get(SALES1, `/scorecards?empId=${DEV2}`).expect(403);
  });

  it('the CTO sees Development and SQA, drafts too, and the draft names the reviewer; Sales and Finance are closed to him', async () => {
    const list = (await get(CTO, `/scorecards?empId=${DEV2}`).expect(200)).body as ScorecardBody[];
    expect(list.map((s) => s.month)).toEqual([M1, M2, M3]);
    expect(list[0]).toMatchObject({ status: 'draft', reviewerEmpId: CTO });
    expect(list[1]).toMatchObject({ status: 'released', reviewerEmpId: CTO, releasedBy: CTO });
    await get(CTO, `/scorecards?empId=${SALES1}`).expect(403);
    await get(CTO, `/scorecards/${cardSalesDraft.id}`).expect(404);
    await get(CTO, `/scorecards?empId=${FINANCE}`).expect(403);
    await get(CTO, `/scorecards/${cardDirector.id}`).expect(404); // above him
  });

  it('the Director sees everyone below, drafts included; the Director has no reviewer and no draft', async () => {
    const sales = (await get(DIRECTOR, `/scorecards?empId=${SALES1}`).expect(200)).body as ScorecardBody[];
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ kind: 'sales', status: 'draft', reviewerEmpId: DIRECTOR });
    expect((await get(DIRECTOR, `/scorecards?empId=${CTO}`).expect(200)).body).toHaveLength(1);
    expect((await get(DIRECTOR, `/scorecards?empId=${DEV2}`).expect(200)).body).toHaveLength(3);
    const own = (await get(DIRECTOR, '/scorecards').expect(200)).body as ScorecardBody[];
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ month: M1, status: 'released' });
    expect(own[0].reviewerEmpId).toBeUndefined();
    expect(own[0].releasedBy).toBeUndefined();
    expect(own[0].releasedAt).toBeDefined();
  });

  it('the CEO / Founder / Owner sees everyone, view only', async () => {
    expect((await get(OWNER, `/scorecards?empId=${DIRECTOR}`).expect(200)).body).toHaveLength(1);
    expect((await get(OWNER, `/scorecards?empId=${SALES1}`).expect(200)).body).toHaveLength(1);
    expect((await get(OWNER, `/scorecards?empId=${DEV2}`).expect(200)).body).toHaveLength(3);
    await get(OWNER, `/scorecards/${cardDev1Draft.id}`).expect(200);
    for (const [url, code] of [
      [`/scorecards/${cardDev1Draft.id}/remark`, 'not_reviewer'],
      [`/scorecards/${cardDev1Draft.id}/release`, 'not_reviewer'],
    ] as const) {
      const res = await post(OWNER, url, url.endsWith('remark') ? { remark: 'Looks fine to me' } : {}).expect(403);
      expect(res.body.code).toBe(code);
    }
  });

  it('a sales scorecard invents nothing: no sales figures, no score, and it says why', async () => {
    const sc = (await get(DIRECTOR, `/scorecards/${cardSalesDraft.id}`).expect(200)).body as DetailBody;
    expect(sc.scorecard.kind).toBe('sales');
    expect(sc.scorecard.metrics).toMatchObject({ activity: null, meetings: null, won: null, dataQuality: null, attendance: null });
    expect(sc.scorecard.score).toBeNull();
    expect(sc.scorecard.band).toBeNull();
    expect(sc.scorecard.smallSample).toBe(false);
    expect(sc.scorecard.unmeasured.map((u) => `${u.key}:${u.reason}`)).toEqual([
      'activity:sales_not_available',
      'meetings:sales_not_available',
      'won:sales_not_available',
      'dataQuality:sales_not_available',
      'attendance:attendance_not_available',
    ]);
    expect(sc.weights.label).toBe('Sales v1');
  });

  it('filters and limits: one month, one scorecard, a bad month is a 400, an unknown person a 404', async () => {
    expect(((await get(CTO, `/scorecards?empId=${DEV2}&month=${M2}`).expect(200)).body as ScorecardBody[]).map((s) => s.month)).toEqual([M2]);
    expect(((await get(CTO, `/scorecards?empId=${DEV2}&limit=2`).expect(200)).body as ScorecardBody[]).map((s) => s.month)).toEqual([M1, M2]);
    await get(CTO, `/scorecards?empId=${DEV2}&month=2026-13`).expect(400);
    await get(CTO, '/scorecards?empId=ACV-9999').expect(404);
    await get(CTO, '/scorecards?empId=bob').expect(400);
    await get(null, '/scorecards').expect(401);
  });

  it('one scorecard with the weights version it was made with, its disputes and its remark history', async () => {
    const detail = (await get(CTO, `/scorecards/${cardDev2Draft.id}`).expect(200)).body as DetailBody;
    expect(detail.scorecard.id).toBe(cardDev2Draft.id);
    expect(detail.scorecard.tasks).toHaveLength(5);
    expect(detail.scorecard.tasks.every((x) => x.counted && x.status === 'approved')).toBe(true);
    expect(detail.weights).toMatchObject({ id: detail.scorecard.weightsVersionId, label: 'Standard v1', weights: { quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10 } });
    // who saved a set and why belong to Settings (settings.view): a scorecard carries the set and its label only
    expect(Object.keys(detail.weights).sort()).toEqual(['effectiveFrom', 'id', 'kind', 'label', 'versionNo', 'weights']);
    expect(detail.disputes).toEqual([]);
    expect(detail.comments).toEqual([]);
    await get(CTO, '/scorecards/not-a-uuid').expect(400);
  });
});

// ------------------------------------------------------------------------------------------------ remark, release, acknowledge

describe('the reviewer remarks and releases; the employee acknowledges; nobody changes the numbers', () => {
  const rowOf = (id: string) => prisma.scorecard.findUniqueOrThrow({ where: { id } });

  it('only the reviewer adds a remark: the Director above the CTO and the employee cannot', async () => {
    const before = await rowOf(cardDev2Draft.id);
    const first = (await post(CTO, `/scorecards/${cardDev2Draft.id}/remark`, { remark: 'Please check task three before release.' }).expect(200)).body as ScorecardBody;
    expect(first).toMatchObject({ status: 'draft', reviewerRemark: 'Please check task three before release.' });
    const second = (await post(CTO, `/scorecards/${cardDev2Draft.id}/remark`, { remark: 'Checked, all good.' }).expect(200)).body as ScorecardBody;
    expect(second.reviewerRemark).toBe('Checked, all good.'); // the newest is shown
    const res = await post(DIRECTOR, `/scorecards/${cardDev2Draft.id}/remark`, { remark: 'I would like to add something' }).expect(403);
    expect(res.body.code).toBe('not_reviewer');
    await post(DEV2, `/scorecards/${cardDev2Draft.id}/remark`, { remark: 'Please be kind to me' }).expect(404); // their own draft does not exist for them
    await post(DEV1, `/scorecards/${cardDev2Draft.id}/remark`, { remark: 'I am a colleague' }).expect(404);
    await post(CTO, `/scorecards/${cardDev2Draft.id}/remark`, { remark: 'x' }).expect(400);
    const detail = (await get(CTO, `/scorecards/${cardDev2Draft.id}`).expect(200)).body as DetailBody;
    expect(detail.comments.map((c) => [c.kind, c.author, c.body])).toEqual([
      ['reviewer_remark', CTO, 'Please check task three before release.'],
      ['reviewer_remark', CTO, 'Checked, all good.'],
    ]);
    // the numbers did not move
    const after = await rowOf(cardDev2Draft.id);
    expect(after.score).toEqual(before.score);
    expect(after.metrics).toEqual(before.metrics);
    expect(after.weightsVersionId).toBe(before.weightsVersionId);
    const audit = (await auditOf('scorecard.remark')).filter((a) => a.targetId === `${DEV2} ${M1}`);
    expect(audit).toHaveLength(2);
  });

  it('only the reviewer releases a draft, with an optional remark; once released it cannot be released again', async () => {
    const before = await rowOf(cardDev2Draft.id);
    expect((await post(DIRECTOR, `/scorecards/${cardDev2Draft.id}/release`).expect(403)).body.code).toBe('not_reviewer');
    await post(DEV2, `/scorecards/${cardDev2Draft.id}/release`).expect(404);
    expect(await statusOf(cardDev2Draft.id)).toBe('draft');

    const released = (await post(CTO, `/scorecards/${cardDev2Draft.id}/release`, { remark: 'Great month, keep it up.' }).expect(200)).body as ScorecardBody;
    expect(released).toMatchObject({ status: 'released', releasedBy: CTO, reviewerEmpId: CTO, reviewerRemark: 'Great month, keep it up.' });
    expect(released.releasedAt).toBeDefined();
    expect((await post(CTO, `/scorecards/${cardDev2Draft.id}/release`).expect(409)).body.code).toBe('invalid_state');

    const after = await rowOf(cardDev2Draft.id);
    expect([after.score, after.band, after.taskCount, after.recomputeCount]).toEqual([before.score, before.band, before.taskCount, before.recomputeCount]);
    expect(after.metrics).toEqual(before.metrics);

    const audit = (await auditOf('scorecard.released')).find((a) => a.targetId === `${DEV2} ${M1}`);
    expect(audit).toMatchObject({ actorId: await eid(CTO), targetType: 'scorecard', outcome: 'success' });
    const events = (await eventsOf('scorecard.released')).filter((e) => e.payload.scorecardId === cardDev2Draft.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: CTO, payload: { empId: DEV2, month: M1, kind: 'standard', releasedBy: CTO, automatic: false, hasRemark: true } });
  });

  it('nobody releases their own scorecard (403 own_scorecard), and a released scorecard of a colleague is not theirs to release', async () => {
    const res = await post(DEV2, `/scorecards/${cardDev2Released.id}/release`).expect(403);
    expect(res.body.code).toBe('own_scorecard');
    expect((await post(DEV1, `/scorecards/${cardDev2Released.id}/release`).expect(404)).body.code).toBe('not_found');
  });

  it('the employee acknowledges a released scorecard with a comment, once', async () => {
    await post(DEV1, `/scorecards/${cardDev2Draft.id}/acknowledge`).expect(404); // not theirs, and not visible
    expect((await post(CTO, `/scorecards/${cardDev2Draft.id}/acknowledge`).expect(403)).body.code).toBe('not_owner'); // visible to the CTO, but not his to acknowledge
    const ack = (await post(DEV2, `/scorecards/${cardDev2Draft.id}/acknowledge`, { comment: 'Thank you, noted.' }).expect(200)).body as ScorecardBody;
    expect(ack).toMatchObject({ status: 'acknowledged', employeeComment: 'Thank you, noted.' });
    expect(ack.acknowledgedAt).toBeDefined();
    expect((await post(DEV2, `/scorecards/${cardDev2Draft.id}/acknowledge`).expect(409)).body.code).toBe('invalid_state');
    // an acknowledged scorecard takes no more remarks
    expect((await post(CTO, `/scorecards/${cardDev2Draft.id}/remark`, { remark: 'One more thing to add' }).expect(409)).body.code).toBe('invalid_state');

    const audit = (await auditOf('scorecard.acknowledged')).find((a) => a.targetId === `${DEV2} ${M1}`);
    expect(audit?.actorId).toBe(await eid(DEV2));
    const events = (await eventsOf('scorecard.acknowledged')).filter((e) => e.payload.scorecardId === cardDev2Draft.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: DEV2, payload: { empId: DEV2, reviewer: CTO, hasComment: true } });
    const detail = (await get(DEV2, `/scorecards/${cardDev2Draft.id}`).expect(200)).body as DetailBody;
    expect(detail.comments.map((c) => c.kind)).toEqual(['reviewer_remark', 'reviewer_remark', 'reviewer_remark', 'employee_comment']);
  });

  it('a draft cannot be acknowledged (it does not exist for the employee) and the Director reviews the Sales scorecard', async () => {
    await post(SALES1, `/scorecards/${cardSalesDraft.id}/acknowledge`).expect(404);
    expect((await post(CTO, `/scorecards/${cardSalesDraft.id}/release`).expect(404)).body.code).toBe('not_found'); // the CTO never sees Sales
    const released = (await post(DIRECTOR, `/scorecards/${cardSalesDraft.id}/release`).expect(200)).body as ScorecardBody;
    expect(released).toMatchObject({ status: 'released', releasedBy: DIRECTOR, score: null, band: null });
    const mine = (await get(SALES1, '/scorecards').expect(200)).body as ScorecardBody[];
    expect(mine.map((s) => s.id)).toEqual([cardSalesDraft.id]);
  });

  it('nobody can change the numbers of a scorecard, not even by a direct database write', async () => {
    const id = cardDev2Released.id;
    await expect(prisma.scorecard.update({ where: { id }, data: { score: 10, band: 'poor' } })).rejects.toThrow(/numbers of a scorecard cannot be changed/);
    await expect(prisma.scorecard.update({ where: { id }, data: { metrics: { quality: 100 } } })).rejects.toThrow(/numbers of a scorecard cannot be changed/);
    await expect(prisma.scorecard.update({ where: { id }, data: { weightsVersionId: weightsV1.sales } })).rejects.toThrow(/keeps its person, month, weights version/);
    await expect(prisma.scorecard.update({ where: { id }, data: { recomputeCount: { increment: 1 } } })).rejects.toThrow(/recomputed only after a dispute decision/);
    await expect(prisma.scorecard.delete({ where: { id } })).rejects.toThrow(/never deleted/);
    await expect(prisma.scorecardTask.updateMany({ where: { scorecardId: id }, data: { rating: 5 } })).rejects.toThrow(/insert-only/);
  });
});

async function statusOf(id: string): Promise<string> {
  return (await prisma.scorecard.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
}

// ------------------------------------------------------------------------------------------------ live figures and the team

describe('live figures (GET /performance/live)', () => {
  it('this month so far, computed from the real tasks: the hand-worked example gives 85 (Excellent); nothing is invented', async () => {
    await makeTask(DEV2, M0, { points: 3, rating: 5 });
    await makeTask(DEV2, M0, { points: 2, rating: 4, late: true });
    await makeTask(DEV2, M0, { points: 5, rating: 3, reworked: true });
    await makeTask(DEV2, M0, { points: 1, rating: 4 });
    await makeTask(DEV2, M0, { points: 3, rating: 5 });
    await makeTask(DEV2, M0, { points: 5, status: 'cancelled', rating: null, title: 'Cancelled by the manager' });
    await makeTask(DEV2, M0, { points: 4, rating: 5, personal: true, title: 'Private to-do' });
    await makeTask(DEV2, nextMonth(M0), { points: 3, status: 'assigned', hours: 8, title: 'Next month, open' });

    const live = (await get(DEV2, '/performance/live').expect(200)).body as LiveBody;
    expect(live).toMatchObject({ empId: DEV2, month: M0, kind: 'standard', score: 85, band: 'excellent', taskCount: 5, smallSample: false });
    expect(live.metrics).toEqual({ quality: 81.4, onTime: 80, completion: 100, rework: 20, attendance: null, workloadHours: 8 });
    expect(live.unmeasured).toEqual([{ key: 'attendance', reason: 'attendance_not_available' }]);
    expect(live.weights).toMatchObject({ label: 'Standard v1', weights: { quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10 } });
    // the cancelled task is listed but not counted; a personal to-do and next month's task are not in the month at all
    expect(live.tasks).toHaveLength(6);
    expect(live.tasks.filter((x) => x.counted)).toHaveLength(5);
    expect(live.tasks.find((x) => x.status === 'cancelled')?.counted).toBe(false);
    expect(live.tasks.some((x) => x.title === 'Private to-do' || x.title === 'Next month, open')).toBe(false);
    // the trend: the closed months with a score (the person sees released ones only), then this month
    expect(live.trend.at(-1)).toEqual({ month: M0, score: 85 });
    expect(live.trend.map((p) => p.month)).toEqual([M3, M2, M1, M0]);
    // reading it again changes nothing
    expect((await get(DEV2, '/performance/live').expect(200)).body).toEqual(live);
  });

  it('a draft is not in the employee\'s own trend, but it is in the trend of the people above', async () => {
    const own = (await get(DEV1, '/performance/live').expect(200)).body as LiveBody;
    expect(own.trend.map((p) => p.month)).toEqual([M4, M3]); // the M1 draft is not released: not theirs to see
    expect(own.score).toBeNull(); // no task this month: no score, not an invented one
    expect(own.band).toBeNull();
    expect(own.unmeasured.map((u) => u.reason)).toContain('nothing_to_measure');
    const seen = (await get(CTO, `/performance/live?empId=${DEV1}`).expect(200)).body as LiveBody;
    expect(seen.trend.map((p) => p.month)).toEqual([M4, M3, M1]);
  });

  it('who may look: yourself and the people below you; a sales person has no sales figures yet', async () => {
    expect((await get(CTO, `/performance/live?empId=${DEV2}`).expect(200)).body.empId).toBe(DEV2);
    expect((await get(DIRECTOR, `/performance/live?empId=${DEV2}`).expect(200)).body.empId).toBe(DEV2);
    expect((await get(OWNER, `/performance/live?empId=${DIRECTOR}`).expect(200)).body.empId).toBe(DIRECTOR);
    expect((await get(DEV2, `/performance/live?empId=${CTO}`).expect(403)).body.code).toBe('forbidden');
    await get(CTO, `/performance/live?empId=${SALES1}`).expect(403);
    await get(CTO, `/performance/live?empId=${DIRECTOR}`).expect(403);
    await get(CTO, '/performance/live?empId=ACV-9999').expect(404);
    await get(null, '/performance/live').expect(401);

    const sales = (await get(DIRECTOR, `/performance/live?empId=${SALES1}`).expect(200)).body as LiveBody;
    expect(sales).toMatchObject({ kind: 'sales', score: null, band: null, taskCount: 0, smallSample: false });
    expect(sales.metrics).toMatchObject({ activity: null, meetings: null, won: null, dataQuality: null, attendance: null });
    expect(sales.unmeasured.filter((u) => u.reason === 'sales_not_available').map((u) => u.key)).toEqual(['activity', 'meetings', 'won', 'dataQuality']);
    expect(sales.weights.label).toBe('Sales v1');
    expect(sales.tasks).toEqual([]);
  });
});

describe('the team table (GET /performance/team): sorted by name, never ranked', () => {
  it('the CTO sees Development and SQA only, in name order, although Mariam has the highest score', async () => {
    const rows = (await get(CTO, '/performance/team').expect(200)).body as TeamRow[];
    expect(rows.map((r) => r.empId)).toEqual([DEV3, SQA1, DEV1, DEV2, SQA2]); // Ali, Danish, Fahad, Mariam, Nida
    const mariam = rows.find((r) => r.empId === DEV2)!;
    expect(mariam.live.score).toBe(85);
    expect(rows.filter((r) => r.empId !== DEV2).every((r) => (r.live.score ?? 0) < 85)).toBe(true); // by score she would be first
    // the newest scorecard of each, drafts included for the person above
    expect(rows.find((r) => r.empId === DEV1)!.latest).toMatchObject({ month: M1, status: 'draft', reviewerEmpId: CTO });
    expect(rows.find((r) => r.empId === DEV3)!.latest).toMatchObject({ month: M3, status: 'released' });
    expect(rows.find((r) => r.empId === SQA1)!.latest).toBeNull();
    expect(rows.find((r) => r.empId === SQA1)!.live).toEqual({ score: null, band: null, smallSample: true });
    expect(mariam.trend.at(-1)).toEqual({ month: M0, score: 85 });
    expect(rows.every((r) => r.kind === 'standard')).toBe(true);
  });

  it('the Director sees everyone below him; the CEO / Founder / Owner sees everyone; nobody else has a team table', async () => {
    const names = async (rows: TeamRow[]) => {
      const people = await prisma.employee.findMany({ where: { empId: { in: rows.map((r) => r.empId) } }, select: { empId: true, fullName: true } });
      return rows.map((r) => people.find((p) => p.empId === r.empId)!.fullName);
    };
    const director = (await get(DIRECTOR, '/performance/team').expect(200)).body as TeamRow[];
    const ids2 = director.map((r) => r.empId);
    expect(ids2).toEqual(expect.arrayContaining([CTO, DEV1, DEV2, DEV3, SALES1, FINANCE, SQA1, SQA2]));
    expect(ids2).not.toContain(DIRECTOR);
    expect(ids2).not.toContain(OWNER);
    const directorNames = await names(director);
    expect(directorNames).toEqual([...directorNames].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
    expect(director.find((r) => r.empId === SALES1)).toMatchObject({ kind: 'sales', live: { score: null, band: null } });
    expect(director.find((r) => r.empId === CTO)!.latest).toMatchObject({ status: 'draft', reviewerEmpId: DIRECTOR });

    const owner = (await get(OWNER, '/performance/team').expect(200)).body as TeamRow[];
    expect(owner.map((r) => r.empId)).toContain(DIRECTOR);
    expect(owner.length).toBe(director.length + 1);
    const ownerNames = await names(owner);
    expect(ownerNames).toEqual([...ownerNames].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));

    for (const who of [DEV2, SALES1, FINANCE]) expect((await get(who, '/performance/team').expect(403)).body.statusCode).toBe(403);
  });
});

// ------------------------------------------------------------------------------------------------ rating disputes

describe('rating disputes', () => {
  let dispute: DisputeBody;
  let upheldAgain: DisputeBody;

  const task1 = () => disputeCard.tasks[0];
  const decideBody = (over: Record<string, unknown> = {}) => ({ change: true, decision: 'Re-checked the work: it deserves 5 stars.', newRating: 5, ...over });

  it('the employee disputes a rated task of their released scorecard; the level above the rater decides', async () => {
    expect((await post(DEV2, '/disputes', { scorecardId: disputeCard.id, taskNumber: task1().number, reason: 'Too short' }).expect(400)).body.statusCode).toBe(400); // under 10 characters
    await post(DEV2, '/disputes', { scorecardId: disputeCard.id, taskNumber: 'task-1', reason: 'The rating is too low for this task.' }).expect(400);
    expect((await post(DEV2, '/disputes', { scorecardId: disputeCard.id, taskNumber: 'TSK-0001', reason: 'The rating is too low for this task.' }).expect(400)).body.code).toBe('not_rated'); // not on the scorecard
    await post(DEV1, '/disputes', { scorecardId: disputeCard.id, taskNumber: task1().number, reason: 'This is not my scorecard.' }).expect(404);
    await post(DEV1, '/disputes', { scorecardId: cardDev1Draft.id, taskNumber: cardDev1Draft.tasks[0].number, reason: 'This is my own draft.' }).expect(404); // a draft is not revealed
    expect((await post(SALES1, '/disputes', { scorecardId: cardSalesDraft.id, taskNumber: 'TSK-0001', reason: 'There are no tasks to dispute.' }).expect(400)).body.code).toBe('not_rated'); // sales scorecards have no task ratings

    const res = await post(DEV2, '/disputes', { scorecardId: disputeCard.id, taskNumber: task1().number, reason: 'The task was bigger than the ticket said.' }).expect(201);
    dispute = res.body as DisputeBody;
    expect(dispute).toMatchObject({ scorecardId: disputeCard.id, empId: DEV2, taskNumber: task1().number, currentRating: 2, status: 'open', deciderEmpId: DIRECTOR, month: M3 });
    expect(dispute.decidedBy).toBeUndefined();
    // one open dispute per task
    expect((await post(DEV2, '/disputes', { scorecardId: disputeCard.id, taskNumber: task1().number, reason: 'Asking for the second time.' }).expect(409)).body.code).toBe('already_disputed');

    const audit = (await auditOf('scorecard.dispute.raised')).find((a) => a.targetId === task1().number);
    expect(audit).toMatchObject({ actorId: await eid(DEV2), targetType: 'dispute', reason: 'The task was bigger than the ticket said.' });
    const events = (await eventsOf('scorecard.dispute_raised')).filter((e) => e.payload.disputeId === dispute.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: DEV2, payload: { empId: DEV2, month: M3, taskNumber: task1().number, ratingAtRaise: 2, decider: DIRECTOR } });
  });

  it('who sees the dispute: the employee, the decider, the people above; nobody beside', async () => {
    for (const who of [DEV2, DIRECTOR, CTO, OWNER]) {
      const list = (await get(who, '/disputes').expect(200)).body as DisputeBody[];
      expect(list.some((d) => d.id === dispute.id)).toBe(true);
    }
    for (const who of [DEV1, SALES1, FINANCE]) {
      const list = (await get(who, '/disputes').expect(200)).body as DisputeBody[];
      expect(list.some((d) => d.id === dispute.id)).toBe(false);
    }
    expect(((await get(DIRECTOR, '/disputes?status=open').expect(200)).body as DisputeBody[]).some((d) => d.id === dispute.id)).toBe(true);
    expect(((await get(DIRECTOR, '/disputes?status=changed').expect(200)).body as DisputeBody[]).some((d) => d.id === dispute.id)).toBe(false);
    await get(DIRECTOR, '/disputes?status=bogus').expect(400);
    const detail = (await get(DEV2, `/scorecards/${disputeCard.id}`).expect(200)).body as DetailBody;
    expect(detail.disputes.map((d) => d.id)).toEqual([dispute.id]);
    await get(DEV1, `/scorecards/${disputeCard.id}`).expect(404);
  });

  it('only the decider decides: not the employee, not the CTO above the employee, not the CEO / Founder / Owner, not a colleague', async () => {
    expect((await post(DEV2, `/disputes/${dispute.id}/decide`, decideBody()).expect(403)).body.code).toBe('own_dispute');
    expect((await post(CTO, `/disputes/${dispute.id}/decide`, decideBody()).expect(403)).body.code).toBe('not_decider');
    expect((await post(OWNER, `/disputes/${dispute.id}/decide`, decideBody()).expect(403)).body.code).toBe('not_decider');
    await post(DEV1, `/disputes/${dispute.id}/decide`, decideBody()).expect(404);
    expect(await prisma.ratingDispute.findUniqueOrThrow({ where: { id: dispute.id } }).then((d) => d.status)).toBe('open');
  });

  it('a decision needs a reason, and a change needs a different rating from 1 to 5', async () => {
    const decide = (body: Record<string, unknown>) => post(DIRECTOR, `/disputes/${dispute.id}/decide`, body);
    await decide({ change: false, decision: '' }).expect(400);
    await decide({ change: false }).expect(400);
    expect((await decide({ change: true, decision: 'Changing it' }).expect(400)).body.code).toBe('rating_required');
    expect((await decide({ change: true, decision: 'Changing it', newRating: 2 }).expect(400)).body.code).toBe('rating_unchanged');
    await decide({ change: true, decision: 'Changing it', newRating: 7 }).expect(400);
    await decide({ change: true, decision: 'Changing it', newRating: 0 }).expect(400);
    expect(await prisma.ratingDispute.findUniqueOrThrow({ where: { id: dispute.id } }).then((d) => d.status)).toBe('open');
  });

  it('CHANGED: the rating changes, the scorecard is recomputed with its own weights version, and the old rating is kept', async () => {
    const before = await prisma.scorecard.findUniqueOrThrow({ where: { id: disputeCard.id } });
    const res = await post(DIRECTOR, `/disputes/${dispute.id}/decide`, decideBody()).expect(200);
    const decided = res.body as DisputeBody;
    expect(decided).toMatchObject({ status: 'changed', decidedBy: DIRECTOR, decision: 'Re-checked the work: it deserves 5 stars.', newRating: 5, currentRating: 2, scoreBefore: 80, scoreAfter: 85 });

    const detail = (await get(DEV2, `/scorecards/${disputeCard.id}`).expect(200)).body as DetailBody;
    expect(detail.scorecard).toMatchObject({ score: 85, band: 'excellent', recomputeCount: 1, status: 'released', weightsVersionId: before.weightsVersionId });
    expect(detail.scorecard.metrics).toMatchObject({ quality: 81.4, onTime: 80, completion: 100, rework: 20, attendance: null });
    expect(detail.scorecard.tasks[0]).toMatchObject({ number: task1().number, rating: 5, originalRating: 2 });
    expect(detail.weights.id).toBe(before.weightsVersionId);
    expect(detail.disputes[0]).toMatchObject({ id: dispute.id, status: 'changed', scoreBefore: 80, scoreAfter: 85 });

    // nothing was overwritten: the snapshot keeps the original rating, the task has BOTH reviews, the dispute holds before and after
    const snapshot = await prisma.scorecardTask.findFirstOrThrow({ where: { scorecardId: disputeCard.id, taskId: task1().id } });
    expect(snapshot.rating).toBe(2);
    const reviews = await prisma.taskReview.findMany({ where: { taskId: task1().id, decision: 'approved' }, orderBy: { createdAt: 'asc' } });
    expect(reviews.map((r) => [r.rating, r.reviewerId])).toEqual([[2, await eid(CTO)], [5, await eid(DIRECTOR)]]);
    const row = await prisma.ratingDispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(row.metricsBefore).toMatchObject({ quality: 68.6 });
    expect(row.metricsAfter).toMatchObject({ quality: 81.4 });

    // the Module 5 task page shows the new rating
    const taskPage = (await get(DEV2, `/tasks/${task1().id}`).expect(200)).body as { task: { rating?: number } };
    expect(taskPage.task.rating).toBe(5);

    const audit = (await auditOf('scorecard.dispute.decided')).find((a) => a.targetId === task1().number);
    expect(audit).toMatchObject({ actorId: await eid(DIRECTOR), reason: 'Re-checked the work: it deserves 5 stars.' });
    expect(audit?.details).toMatchObject({ before: { rating: 2, score: 80 }, after: { rating: 5, score: 85 } });
    const events = (await eventsOf('scorecard.dispute_decided')).filter((e) => e.payload.disputeId === dispute.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: DIRECTOR, payload: { decision: 'changed', decidedBy: DIRECTOR, ratingBefore: 2, ratingAfter: 5, scoreBefore: 80, scoreAfter: 85 } });

    expect((await post(DIRECTOR, `/disputes/${dispute.id}/decide`, decideBody({ newRating: 4 })).expect(409)).body.code).toBe('already_decided');
  });

  it('a task can be disputed again after a decision; UPHELD closes it and changes nothing', async () => {
    const res = await post(DEV2, '/disputes', { scorecardId: disputeCard.id, taskNumber: task1().number, reason: 'Still too low in my opinion.' }).expect(201);
    upheldAgain = res.body as DisputeBody;
    expect(upheldAgain).toMatchObject({ currentRating: 5, status: 'open', deciderEmpId: DIRECTOR }); // the Director gave the 5 now: the Director looks again
    expect((await post(DIRECTOR, `/disputes/${upheldAgain.id}/decide`, decideBody({ newRating: 5 })).expect(400)).body.code).toBe('rating_unchanged');

    const before = await prisma.scorecard.findUniqueOrThrow({ where: { id: disputeCard.id } });
    const decided = (await post(DIRECTOR, `/disputes/${upheldAgain.id}/decide`, { change: false, decision: 'The rating of 5 stands.' }).expect(200)).body as DisputeBody;
    expect(decided).toMatchObject({ status: 'upheld', decidedBy: DIRECTOR, decision: 'The rating of 5 stands.' });
    expect(decided.newRating).toBeUndefined();
    expect(decided.scoreAfter).toBeUndefined();
    const after = await prisma.scorecard.findUniqueOrThrow({ where: { id: disputeCard.id } });
    expect([after.score, after.band, after.recomputeCount]).toEqual([before.score, before.band, before.recomputeCount]);
    expect(after.metrics).toEqual(before.metrics);
    expect(await prisma.taskReview.count({ where: { taskId: task1().id, decision: 'approved' } })).toBe(2); // no review for an upheld dispute
    const events = (await eventsOf('scorecard.dispute_decided')).filter((e) => e.payload.disputeId === upheldAgain.id);
    expect(events[0].payload).toMatchObject({ decision: 'upheld', ratingBefore: 5, ratingAfter: null, scoreBefore: null, scoreAfter: null });
  });

  it('two decisions at the same moment: one wins, the scorecard is recomputed exactly once', async () => {
    const task4 = disputeCard.tasks[3];
    const raised = (await post(DEV2, '/disputes', { scorecardId: disputeCard.id, taskNumber: task4.number, reason: 'This was rated too low as well.' }).expect(201)).body as DisputeBody;
    const body = { change: true, decision: 'Both of us clicked at once.', newRating: 5 };
    const results = await Promise.all([post(DIRECTOR, `/disputes/${raised.id}/decide`, body), post(DIRECTOR, `/disputes/${raised.id}/decide`, body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const card = await prisma.scorecard.findUniqueOrThrow({ where: { id: disputeCard.id } });
    expect(card.recomputeCount).toBe(2);
    expect(await prisma.ratingDispute.count({ where: { scorecardId: disputeCard.id, status: 'changed' } })).toBe(2);
    expect(await prisma.taskReview.count({ where: { taskId: task4.id, decision: 'approved' } })).toBe(2);
    // quality: (3x5 + 2x4 + 5x3 + 1x5 + 3x5) / 14 x 20 = 58 / 14 x 20 = 82.9
    expect(card.metrics).toMatchObject({ quality: 82.9 });
  });

  it('after the decisions the rule still holds: the numbers cannot be changed, and one decision pays for one recompute only', async () => {
    await expect(prisma.scorecard.update({ where: { id: disputeCard.id }, data: { score: 50, band: 'poor' } })).rejects.toThrow(/numbers of a scorecard cannot be changed/);
    // two changed disputes, two recomputes: a third recompute has nothing to pay for it
    await expect(prisma.scorecard.update({ where: { id: disputeCard.id }, data: { recomputeCount: { increment: 1 }, score: 50, band: 'poor' } })).rejects.toThrow(/recomputed only after a dispute decision/);
    await expect(prisma.ratingDispute.update({ where: { id: dispute.id }, data: { newRating: 1 } })).rejects.toThrow(/decided rating dispute cannot be changed/);
    await expect(prisma.ratingDispute.delete({ where: { id: dispute.id } })).rejects.toThrow(/never deleted/);
  });

  it('a rating the Director gave is looked at again by the Director: the CTO does not decide it', async () => {
    const task = directorRatedCard.tasks[0];
    const raised = (await post(DEV1, '/disputes', { scorecardId: directorRatedCard.id, taskNumber: task.number, reason: 'The Director rated this too low.' }).expect(201)).body as DisputeBody;
    expect(raised).toMatchObject({ currentRating: 3, deciderEmpId: DIRECTOR });
    expect((await post(CTO, `/disputes/${raised.id}/decide`, decideBody()).expect(403)).body.code).toBe('not_decider');
    expect(await prisma.ratingDispute.findUniqueOrThrow({ where: { id: raised.id } }).then((d) => d.status)).toBe('open');
  });
});

// ------------------------------------------------------------------------------------------------ the approvals inbox

describe('approvals inbox: scorecard and dispute items', () => {
  const itemsOf = async (who: string): Promise<ApprovalItem[]> => ((await get(who, '/approvals').expect(200)).body as { items: ApprovalItem[] }).items;
  const decide = (who: string, id: string, decision: 'approve' | 'reject', body: Record<string, unknown> = {}) => post(who, `/approvals/${encodeURIComponent(id)}/${decision}`, body);
  let disputeA: DisputeBody;
  let disputeB: DisputeBody;

  it('the reviewer sees the drafts waiting for them, with the same words as the mock screens', async () => {
    const ctoItems = await itemsOf(CTO);
    const draft = ctoItems.find((i) => i.id === `scorecard:${cardDev1Draft.id}`);
    expect(draft).toMatchObject({
      type: 'scorecard',
      refId: cardDev1Draft.id,
      requester: DEV1,
      href: `/performance/scorecards/${cardDev1Draft.id}`,
      approveLabel: 'Release',
      rejectLabel: 'Add remark, keep draft',
    });
    expect(draft?.title).toMatch(new RegExp(`^${monthName(M1)} scorecard · 85 \\(Excellent\\)$`));
    expect(draft?.subtitle).toBe('Fahad Khan · 5 tasks. Review and release; you can add a remark but not change the numbers.');
    // not his own draft (the Director reviews it), and not a draft that is already released
    expect(ctoItems.some((i) => i.id === `scorecard:${cardCtoDraft.id}`)).toBe(false);
    expect(ctoItems.some((i) => i.id === `scorecard:${cardDev2Draft.id}`)).toBe(false);
    expect(ctoItems.some((i) => i.type === 'dispute')).toBe(false);

    const directorItems = await itemsOf(DIRECTOR);
    expect(directorItems.some((i) => i.id === `scorecard:${cardCtoDraft.id}`)).toBe(true);
    expect(directorItems.some((i) => i.id === `scorecard:${cardDev1Draft.id}`)).toBe(false); // the CTO's to release
    expect(directorItems.some((i) => i.id === `scorecard:${cardDirector.id}`)).toBe(false); // released by the system
  });

  it('the CEO / Founder / Owner and the employees get no scorecard items; the people above can watch what waits for others', async () => {
    for (const who of [OWNER, DEV1, DEV2, SALES1, FINANCE]) {
      expect((await itemsOf(who)).filter((i) => i.type === 'scorecard' || i.type === 'dispute')).toEqual([]);
    }
    const watched = (await get(DIRECTOR, '/approvals/oversight').expect(200)).body as ApprovalItem[];
    expect(watched.find((i) => i.id === `scorecard:${cardDev1Draft.id}`)?.waitingFor).toBe(CTO);
    expect(watched.some((i) => i.id === `scorecard:${cardCtoDraft.id}`)).toBe(false); // his own to decide: in his inbox, not here
    const everything = (await get(OWNER, '/approvals/oversight').expect(200)).body as ApprovalItem[];
    expect(everything.find((i) => i.id === `scorecard:${cardDev1Draft.id}`)?.waitingFor).toBe(CTO);
    expect(everything.find((i) => i.id === `scorecard:${cardCtoDraft.id}`)?.waitingFor).toBe(DIRECTOR);
    expect(await get(DEV1, '/approvals/oversight').expect(200).then((r) => r.body)).toEqual([]);
  });

  it('a dispute waits in the inbox of its decider only', async () => {
    disputeA = (await post(DEV3, '/disputes', { scorecardId: dev3Card.id, taskNumber: dev3Card.tasks[0].number, reason: 'This should have been a four.' }).expect(201)).body as DisputeBody;
    disputeB = (await post(DEV3, '/disputes', { scorecardId: dev3Card.id, taskNumber: dev3Card.tasks[1].number, reason: 'The deadline was moved, this was on time.' }).expect(201)).body as DisputeBody;
    const item = (await itemsOf(DIRECTOR)).find((i) => i.id === `dispute:${disputeA.id}`);
    expect(item).toMatchObject({
      type: 'dispute',
      refId: disputeA.id,
      refNumber: dev3Card.tasks[0].number,
      requester: DEV3,
      href: `/performance/scorecards/${dev3Card.id}`,
      needsRating: true,
      approveLabel: 'Change rating',
      rejectLabel: 'Keep rating',
      subtitle: '“This should have been a four.”',
    });
    expect(item?.title).toBe('Rating dispute: Work item ' + dev3Card.tasks[0].number.slice(4) + ' (3★)');
    expect((await itemsOf(CTO)).some((i) => i.id === `dispute:${disputeA.id}`)).toBe(false);
    const watched = (await get(OWNER, '/approvals/oversight').expect(200)).body as ApprovalItem[];
    expect(watched.find((i) => i.id === `dispute:${disputeA.id}`)?.waitingFor).toBe(DIRECTOR);
  });

  it('release from the inbox: only the reviewer; "reject" adds a remark and keeps the draft', async () => {
    const id = `scorecard:${cardDev1Draft.id}`;
    expect((await decide(DIRECTOR, id, 'approve').expect(403)).body.message).toMatch(/not waiting for you/);
    expect((await decide(DEV1, id, 'approve').expect(403)).body.statusCode).toBe(403);
    expect((await decide(CTO, id, 'reject').expect(400)).body.code).toBe('reason_required'); // the reason is the remark
    expect(await statusOf(cardDev1Draft.id)).toBe('draft');

    await decide(CTO, id, 'reject', { reason: 'Please add the missing test notes first.' }).expect(201);
    expect(await statusOf(cardDev1Draft.id)).toBe('draft'); // kept as a draft
    expect((await itemsOf(CTO)).some((i) => i.id === id)).toBe(true);
    expect(((await get(CTO, `/scorecards/${cardDev1Draft.id}`).expect(200)).body as DetailBody).scorecard.reviewerRemark).toBe('Please add the missing test notes first.');

    const before = await prisma.scorecard.findUniqueOrThrow({ where: { id: cardDev1Draft.id } });
    await decide(CTO, id, 'approve', { reason: 'Notes added, good work.' }).expect(201);
    const after = await prisma.scorecard.findUniqueOrThrow({ where: { id: cardDev1Draft.id } });
    expect(after.status).toBe('released');
    expect(after.releasedById).toBe(await eid(CTO));
    expect(after.score).toEqual(before.score);
    expect((await itemsOf(CTO)).some((i) => i.id === id)).toBe(false);
    expect(((await get(DEV1, `/scorecards/${cardDev1Draft.id}`).expect(200)).body as DetailBody).scorecard.reviewerRemark).toBe('Notes added, good work.');
    // the Director releases the CTO's own scorecard
    await decide(DIRECTOR, `scorecard:${cardCtoDraft.id}`, 'approve').expect(201);
    expect(await statusOf(cardCtoDraft.id)).toBe('released');
  });

  it('change the rating from the inbox: a rating is needed; keep the rating with the default words', async () => {
    const a = `dispute:${disputeA.id}`;
    const b = `dispute:${disputeB.id}`;
    expect((await decide(CTO, a, 'approve', { rating: 4 }).expect(403)).body.message).toMatch(/not waiting for you/);
    expect((await decide(DIRECTOR, a, 'approve').expect(400)).body.code).toBe('rating_required');
    await decide(DIRECTOR, a, 'approve', { rating: 4, reason: 'Agreed, it is a four.' }).expect(201);
    const changed = (await get(DEV3, '/disputes').expect(200)).body as DisputeBody[];
    expect(changed.find((d) => d.id === disputeA.id)).toMatchObject({ status: 'changed', newRating: 4, decision: 'Agreed, it is a four.', decidedBy: DIRECTOR });
    const card = (await get(DEV3, `/scorecards/${dev3Card.id}`).expect(200)).body as DetailBody;
    expect(card.scorecard.recomputeCount).toBe(1);
    expect(card.scorecard.tasks[0]).toMatchObject({ rating: 4, originalRating: 3 });

    await decide(DIRECTOR, b, 'reject').expect(201);
    const kept = ((await get(DEV3, '/disputes').expect(200)).body as DisputeBody[]).find((d) => d.id === disputeB.id);
    expect(kept).toMatchObject({ status: 'upheld', decision: 'Rating kept.' });
    expect((await itemsOf(DIRECTOR)).some((i) => i.id === a || i.id === b)).toBe(false);
    expect((await decide(DIRECTOR, a, 'approve', { rating: 5 }).expect(403)).body.message).toMatch(/not waiting for you/); // decided: no longer waiting
  });
});

const monthName = (month: string): string => ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(month.slice(5)) - 1] + ' ' + month.slice(0, 4);

// ------------------------------------------------------------------------------------------------ the score weights

describe('score weight versions', () => {
  const STANDARD_40 = { quality: 40, onTime: 20, completion: 20, rework: 10, attendance: 10 };
  const save = (who: string | null, body: Record<string, unknown>) => post(who, '/settings/score-weights', body);
  const list = async (who: string, query = ''): Promise<WeightsBody[]> => (await get(who, `/settings/score-weights${query}`).expect(200)).body as WeightsBody[];

  it('who may list the versions: the Owner, the Director and the CTO (settings.view); the starting versions come with the system', async () => {
    for (const who of [OWNER, DIRECTOR, CTO]) expect(await list(who)).toHaveLength(2);
    for (const who of [DEV1, SALES1, FINANCE]) await get(who, '/settings/score-weights').expect(403);
    await get(null, '/settings/score-weights').expect(401);
    const starting = await list(DIRECTOR);
    const standard = starting.find((v) => v.kind === 'standard')!;
    const sales = starting.find((v) => v.kind === 'sales')!;
    expect(standard).toMatchObject({ label: 'Standard v1', versionNo: 1, createdBy: null, weights: { quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10 } });
    expect(sales).toMatchObject({ label: 'Sales v1', versionNo: 1, createdBy: null, weights: { activity: 20, meetings: 25, won: 30, dataQuality: 10, attendance: 15 } });
    expect((await list(DIRECTOR, '?kind=sales')).map((v) => v.label)).toEqual(['Sales v1']);
    await get(DIRECTOR, '/settings/score-weights?kind=bogus').expect(400);
  });

  it('only the Director saves a new version', async () => {
    for (const who of [OWNER, CTO, DEV1, SALES1, FINANCE]) {
      expect((await save(who, { kind: 'standard', weights: STANDARD_40, reason: 'I would like to change it' }).expect(403)).body.statusCode).toBe(403);
    }
    await save(null, { kind: 'standard', weights: STANDARD_40, reason: 'Not logged in' }).expect(401);
    expect(await prisma.scoreWeightVersion.count()).toBe(2);
  });

  it('a set must name the metrics of its kind, be whole percents from 0 to 100 and add up to exactly 100', async () => {
    const bad = async (weights: Record<string, number>, code: string, kind = 'standard') => {
      const res = await save(DIRECTOR, { kind, weights, reason: 'Testing the checks' }).expect(400);
      expect(res.body.code).toBe(code);
      return res.body.message as string;
    };
    expect(await bad({ quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 9 }, 'weights_sum')).toBe('Weights must add up to 100% (now 99%).');
    await bad({ quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 11 }, 'weights_sum');
    await bad({ quality: 35.5, onTime: 24.5, completion: 20, rework: 10, attendance: 10 }, 'weights_whole');
    await bad({ quality: -10, onTime: 60, completion: 30, rework: 10, attendance: 10 }, 'weights_range');
    await bad({ quality: 50, onTime: 25, completion: 25 }, 'weights_keys');
    await bad({ quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 5, bonus: 5 }, 'weights_keys');
    await bad({ activity: 20, meetings: 25, won: 30, dataQuality: 10, attendance: 15 }, 'weights_keys'); // the sales metrics under the standard kind
    await bad(STANDARD_40, 'weights_keys', 'sales'); // and the other way round
    await save(DIRECTOR, { kind: 'standard', weights: STANDARD_40, reason: 'ab' }).expect(400); // a reason is needed
    await save(DIRECTOR, { kind: 'standard', weights: STANDARD_40 }).expect(400);
    await save(DIRECTOR, { kind: 'standard', weights: STANDARD_40, reason: 'An extra field', bonus: true }).expect(400);
    expect((await save(DIRECTOR, { kind: 'standard', departmentId: '00000000-0000-4000-8000-000000000000', weights: STANDARD_40, reason: 'No such department' }).expect(400)).body.code).toBe('department_not_found');
    expect(await prisma.scoreWeightVersion.count()).toBe(2); // none of them was saved
  });

  it('the Director saves a NEW version: audited, announced, listed first; the old version is untouched', async () => {
    const res = await save(DIRECTOR, { kind: 'standard', weights: STANDARD_40, reason: 'Quality matters more this year' }).expect(201);
    const created = res.body as WeightsBody;
    expect(created).toMatchObject({ label: 'Standard v2', kind: 'standard', versionNo: 2, createdBy: DIRECTOR, note: 'Quality matters more this year', weights: STANDARD_40 });
    expect(created.departmentId).toBeUndefined();

    const all = await list(CTO);
    expect(all[0].id).toBe(created.id); // newest first
    expect(all).toHaveLength(3);
    const old = await prisma.scoreWeightVersion.findUniqueOrThrow({ where: { id: weightsV1.standard } });
    expect(old.weights).toEqual({ quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10 });

    const audit = (await auditOf('settings.score_weights.created'))[0];
    expect(audit).toMatchObject({ actorId: await eid(DIRECTOR), targetType: 'settings', targetId: 'score-weights', reason: 'Quality matters more this year' });
    expect(audit.details).toMatchObject({ before: { quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10 }, after: STANDARD_40, kind: 'standard', versionNo: 2 });
    const events = await eventsOf('score_weights.created');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: DIRECTOR, payload: { versionId: created.id, kind: 'standard', departmentId: null, versionNo: 2, previousVersionId: weightsV1.standard, weights: STANDARD_40 } });
  });

  it('two saves at the same moment get two different version numbers', async () => {
    const [a, b] = await Promise.all([
      save(DIRECTOR, { kind: 'standard', weights: { quality: 30, onTime: 30, completion: 20, rework: 10, attendance: 10 }, reason: 'First of two' }),
      save(DIRECTOR, { kind: 'standard', weights: { quality: 30, onTime: 20, completion: 30, rework: 10, attendance: 10 }, reason: 'Second of two' }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.versionNo, b.body.versionNo].sort()).toEqual([3, 4]);
    // put the starting-like set back as the newest, so the next tests have a known "current" standard set
    const back = (await save(DIRECTOR, { kind: 'standard', weights: STANDARD_40, reason: 'Back to forty' }).expect(201)).body as WeightsBody;
    expect(back.versionNo).toBe(5);
  });

  it('a version of the sales kind has its own numbering', async () => {
    const sales = (await save(DIRECTOR, { kind: 'sales', weights: { activity: 25, meetings: 25, won: 25, dataQuality: 15, attendance: 10 }, reason: 'Even out the sales weights' }).expect(201)).body as WeightsBody;
    expect(sales).toMatchObject({ label: 'Sales v2', kind: 'sales', versionNo: 2 });
    expect((await list(DIRECTOR, '?kind=sales')).map((v) => v.label)).toEqual(['Sales v2', 'Sales v1']);
  });

  it('live figures use the newest version; a scorecard keeps the version it was made with, also when a dispute recomputes it', async () => {
    const live = (await get(DEV2, '/performance/live').expect(200)).body as LiveBody;
    expect(live.weights).toMatchObject({ label: 'Standard v5', versionNo: 5, weights: STANDARD_40 });

    // the weights card (made with version 1): tasks 2x2 and 2x4: quality 60, on time 100, completion 100, rework 0
    //   version 1: (35 x 60 + 25 x 100 + 20 x 100 + 10 x 100) / 90 = 84.4; after the task changes from 2 to 5 stars (quality 90): 96.1
    //   the current version 5 would give (40 x 90 + 20 x 100 + 20 x 100 + 10 x 100) / 90 = 95.6, not 96.1
    const before = (await get(DEV1, `/scorecards/${weightsCard.id}`).expect(200)).body as DetailBody;
    expect(before.scorecard).toMatchObject({ score: 84.4, band: 'good', weightsVersionId: weightsV1.standard });
    const raised = (await post(DEV1, '/disputes', { scorecardId: weightsCard.id, taskNumber: weightsCard.tasks[0].number, reason: 'The weights task was harder than rated.' }).expect(201)).body as DisputeBody;
    const decided = (await post(DIRECTOR, `/disputes/${raised.id}/decide`, { change: true, decision: 'It deserves five stars.', newRating: 5 }).expect(200)).body as DisputeBody;
    expect(decided).toMatchObject({ scoreBefore: 84.4, scoreAfter: 96.1 });
    const after = (await get(DEV1, `/scorecards/${weightsCard.id}`).expect(200)).body as DetailBody;
    expect(after.scorecard).toMatchObject({ score: 96.1, band: 'excellent', recomputeCount: 1, weightsVersionId: weightsV1.standard });
    expect(after.scorecard.metrics.quality).toBe(90);
    expect(after.weights).toMatchObject({ id: weightsV1.standard, label: 'Standard v1', versionNo: 1 });
  });

  it('everybody reads the weights with their own figures and scorecards, but never the Director\'s reason or who saved them: that stays in Settings (settings.view)', async () => {
    // the newest version (5) was saved with the reason "Back to forty"; version 1 came with the system and carries a note too
    const live = (await get(DEV2, '/performance/live').expect(200)).body as LiveBody;
    expect(live.weights).toMatchObject({ label: 'Standard v5', versionNo: 5, weights: STANDARD_40 });
    expect(Object.keys(live.weights)).not.toContain('note');
    expect(Object.keys(live.weights)).not.toContain('createdBy');
    expect(JSON.stringify(live)).not.toContain('Back to forty');
    const detail = (await get(DEV2, `/scorecards/${cardDev2Released.id}`).expect(200)).body as DetailBody;
    expect(detail.weights).toMatchObject({ label: 'Standard v1' });
    expect(Object.keys(detail.weights)).not.toContain('note');
    expect(Object.keys(detail.weights)).not.toContain('createdBy');
    expect(JSON.stringify(detail)).not.toContain('Starting weights');
    // the people above see the same slim view: the reason is for the Settings screen only
    expect(Object.keys(((await get(CTO, `/performance/live?empId=${DEV2}`).expect(200)).body as LiveBody).weights)).not.toContain('note');
    // Settings still carries both for the people who may open it
    const settings = (await list(CTO)).find((v) => v.versionNo === 5 && v.kind === 'standard' && !v.departmentId)!;
    expect(settings).toMatchObject({ note: 'Back to forty', createdBy: DIRECTOR });
  });

  it('a department can have its own set, which wins for its people; other departments keep theirs', async () => {
    const dep = await prisma.department.findUniqueOrThrow({ where: { code: 'dep-eng' } });
    const own = { quality: 25, onTime: 25, completion: 25, rework: 15, attendance: 10 };
    const created = (await save(DIRECTOR, { kind: 'standard', departmentId: dep.id, weights: own, reason: 'Engineering has its own weights' }).expect(201)).body as WeightsBody;
    expect(created).toMatchObject({ label: 'Standard v1', versionNo: 1, departmentId: dep.id, departmentName: dep.name, weights: own });
    expect((await list(DIRECTOR, `?departmentId=${dep.id}`)).map((v) => v.id)).toEqual([created.id]);
    expect(((await get(DEV2, '/performance/live').expect(200)).body as LiveBody).weights).toMatchObject({ id: created.id, departmentId: dep.id, weights: own });
    expect(((await get(DIRECTOR, `/performance/live?empId=${SALES1}`).expect(200)).body as LiveBody).weights).toMatchObject({ label: 'Sales v2', kind: 'sales' });
    // the audit shows what the department's set replaced: the company-wide set
    const audit = (await auditOf('settings.score_weights.created')).at(-1);
    expect(audit?.details).toMatchObject({ before: STANDARD_40, after: own, departmentId: dep.id, versionNo: 1 });
    // a second set for the same department is its version 2
    const second = (await save(DIRECTOR, { kind: 'standard', departmentId: dep.id, weights: STANDARD_40, reason: 'Engineering moves back' }).expect(201)).body as WeightsBody;
    expect(second).toMatchObject({ label: 'Standard v2', versionNo: 2, departmentId: dep.id });
  });
});

// ------------------------------------------------------------------------------------------------ the reviewer has left

describe('the manager has left: the next level up that reviews work takes the scorecard over', () => {
  const itemsOf = async (who: string): Promise<ApprovalItem[]> => ((await get(who, '/approvals').expect(200)).body as { items: ApprovalItem[] }).items;

  it('the draft moves to the Director (view, inbox, remark, release); the stored reviewer stays the CTO; before that the Director could do none of it', async () => {
    const month = previousMonth(M4); // a month nothing else in this file uses
    const card = await makeCard(SQA2, month, [{ points: 3, rating: 4 }, { points: 2, rating: 5 }], { reviewer: CTO });
    const item = `scorecard:${card.id}`;

    // while the CTO is the manager, the draft waits for him and the Director only watches
    expect((await itemsOf(CTO)).some((i) => i.id === item)).toBe(true);
    expect((await itemsOf(DIRECTOR)).some((i) => i.id === item)).toBe(false);
    expect(((await get(DIRECTOR, `/scorecards/${card.id}`).expect(200)).body as DetailBody).scorecard.reviewerEmpId).toBe(CTO);
    expect((await post(DIRECTOR, `/scorecards/${card.id}/remark`, { remark: 'Looking at it early' }).expect(403)).body.code).toBe('not_reviewer');
    expect((await post(DIRECTOR, `/scorecards/${card.id}/release`).expect(403)).body.code).toBe('not_reviewer');

    await prisma.employee.update({ where: { empId: CTO }, data: { status: 'left' } });
    try {
      // the draft now names the Director as the reviewer and waits in his inbox
      expect(((await get(DIRECTOR, `/scorecards/${card.id}`).expect(200)).body as DetailBody).scorecard).toMatchObject({ status: 'draft', reviewerEmpId: DIRECTOR });
      expect((await itemsOf(DIRECTOR)).some((i) => i.id === item)).toBe(true);
      expect(((await get(DIRECTOR, '/approvals/oversight').expect(200)).body as ApprovalItem[]).some((i) => i.id === item)).toBe(false); // his own to decide, not one to watch

      const remarked = (await post(DIRECTOR, `/scorecards/${card.id}/remark`, { remark: 'Taking this over from the CTO.' }).expect(200)).body as ScorecardBody;
      expect(remarked).toMatchObject({ status: 'draft', reviewerRemark: 'Taking this over from the CTO.' });
      const released = (await post(DIRECTOR, `/scorecards/${card.id}/release`).expect(200)).body as ScorecardBody;
      expect(released).toMatchObject({ status: 'released', releasedBy: DIRECTOR, reviewerEmpId: DIRECTOR });
      expect((await itemsOf(DIRECTOR)).some((i) => i.id === item)).toBe(false); // done: it left the inbox

      // the database keeps the reviewer the scorecard was made with; who released it is the Director
      const row = await prisma.scorecard.findUniqueOrThrow({ where: { id: card.id } });
      expect(row.status).toBe('released');
      expect(row.reviewerId).toBe(await eid(CTO));
      expect(row.releasedById).toBe(await eid(DIRECTOR));
      const audit = (await auditOf('scorecard.released')).find((a) => a.targetId === `${SQA2} ${month}`);
      expect(audit).toMatchObject({ actorId: await eid(DIRECTOR), targetType: 'scorecard' });
      const events = (await eventsOf('scorecard.released')).filter((e) => e.payload.scorecardId === card.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor: DIRECTOR, payload: { empId: SQA2, month, releasedBy: DIRECTOR, automatic: false, hasRemark: false } });
    } finally {
      await prisma.employee.update({ where: { empId: CTO }, data: { status: 'active' } });
    }
  });
});

// ------------------------------------------------------------------------------------------------ blocked attempts

describe('a scorecard or dispute the caller may not see answers 404 and is recorded as a blocked attempt (plan section 8)', () => {
  const blockedOf = async (empId: string) => {
    await t.app.get(ActivityRecorder).flush();
    return prisma.activityEvent.findMany({ where: { employee: { empId }, action: 'blocked' }, orderBy: { occurredAt: 'asc' } });
  };

  it('a colleague beside, probing a scorecard or a dispute that exists, is recorded; an id that does not exist, and the employee\'s own draft, are not', async () => {
    const before = (await blockedOf(DEV1)).length;
    const probes = async (): Promise<number> => (await blockedOf(DEV1)).length - before;

    // DEV1 is beside DEV2 (the same manager): the scorecard exists, but is not his to see
    await get(DEV1, `/scorecards/${disputeCard.id}`).expect(404);
    expect(await probes()).toBe(1);
    await post(DEV1, `/scorecards/${disputeCard.id}/remark`, { remark: 'A remark from a colleague' }).expect(404);
    await post(DEV1, `/scorecards/${disputeCard.id}/release`).expect(404);
    await post(DEV1, `/scorecards/${disputeCard.id}/acknowledge`).expect(404);
    expect(await probes()).toBe(4);
    await post(DEV1, '/disputes', { scorecardId: disputeCard.id, taskNumber: disputeCard.tasks[0].number, reason: 'Trying someone else\'s scorecard.' }).expect(404);
    expect(await probes()).toBe(5);
    const someDispute = await prisma.ratingDispute.findFirstOrThrow({ where: { employee: { empId: DEV2 } }, select: { id: true } });
    await post(DEV1, `/disputes/${someDispute.id}/decide`, { change: false, decision: 'I would like to decide this one.' }).expect(404);
    expect(await probes()).toBe(6);

    const last = (await blockedOf(DEV1)).at(-1)!;
    expect((last.details as { status: number; route: string }).status).toBe(404);
    expect((last.details as { route: string }).route).toContain('/disputes/:id/decide');

    // an id nobody has is not an attempt to see something
    await get(DEV1, '/scorecards/00000000-0000-4000-8000-000000000000').expect(404);
    await post(DEV1, '/disputes', { scorecardId: '00000000-0000-4000-8000-000000000000', taskNumber: 'TSK-0001', reason: 'There is no such scorecard.' }).expect(404);
    await post(DEV1, '/disputes/00000000-0000-4000-8000-000000000000/decide', { change: false, decision: 'There is no such dispute.' }).expect(404);
    expect(await probes()).toBe(6);

    // an employee asking for their own draft (hidden from them by design) is not an attempt either
    const month = previousMonth(previousMonth(M4));
    const draft = await makeCard(SQA1, month, [{ points: 2, rating: 4 }]);
    const sqaBefore = (await blockedOf(SQA1)).length;
    await get(SQA1, `/scorecards/${draft.id}`).expect(404);
    await post(SQA1, `/scorecards/${draft.id}/acknowledge`).expect(404);
    await post(SQA1, '/disputes', { scorecardId: draft.id, taskNumber: draft.tasks[0].number, reason: 'This is my own draft.' }).expect(404);
    expect((await blockedOf(SQA1)).length).toBe(sqaBefore);

    // somebody who may see it (the people above) is not blocked
    const ctoBefore = (await blockedOf(CTO)).length;
    await get(CTO, `/scorecards/${draft.id}`).expect(200);
    expect((await blockedOf(CTO)).length).toBe(ctoBefore);
  });
});
