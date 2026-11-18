import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/access/audit.service';
import { ENV } from '../src/config/config.module';
import type { Env } from '../src/config/env';
import { OutboxDispatcher } from '../src/events/outbox-dispatcher.service';
import { OutboxService } from '../src/events/outbox.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { JobRunner } from '../src/jobs/job-runner.service';
import { ATTENDANCE_SOURCE, NotBuiltAttendanceSource, type AttendanceSource } from '../src/performance/attendance-source';
import { PerformanceCalculator } from '../src/performance/performance-calculator.service';
import { DISPUTE_INCLUDE, disputeDecidedPayload, disputeRaisedPayload, releasedPayload, SCORECARD_INCLUDE } from '../src/performance/performance-data';
import { PerformanceDirectory } from '../src/performance/performance-directory.service';
import { PerformanceMail } from '../src/performance/performance-mail.service';
import type { SalesDetail } from '../src/performance/rules/perf-tasks';
import { NotBuiltSalesSource, SALES_SOURCE, type SalesSource } from '../src/performance/sales-source';
import { ScorecardMonthly } from '../src/performance/scorecard-monthly.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type TestApp } from './helpers/app';
import { createEmployee } from './helpers/people';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 6 automation: the monthly scorecard job (scheduled, run through the job runner, idempotent, retried after a partial failure,
 * month boundaries in Pakistan time, the weights version in force for the person's kind and department, the Director's scorecard
 * released at once), the attendance and sales stand-ins (nothing is ever invented, a real source plugs in) and the performance
 * mails (reviewer digest, release, dispute raised, dispute decided). Tasks are written straight into the tables (the endpoints are
 * tested in m6-core.test.ts); the outbox dispatcher (tick) and the job runner (tick) are driven by hand and the fake clock is moved.
 * Months used: 2026-10 (the main run), 09 (a failing person, then a retry), 05 (mail server down), 03 (real sources), 06 (tasks
 * waiting for review, extensions asked for after the deadline), 11 (weights versions), 07 (who gets one), 2025-12 (before anybody
 * joined).
 */
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003'; // Bilal Ahmed, bilal@acevatech.com
const CTO = 'ACV-0004'; // Omar Farooq, omar@acevatech.com
const DEV1 = 'ACV-0006'; // Fahad Khan
const DEV2 = 'ACV-0007'; // Mariam Shah, mariam@acevatech.com
const DEV3 = 'ACV-0008'; // Ali Raza
const SALES1 = 'ACV-0009'; // Hira Baig
const FINANCE = 'ACV-0010'; // Sana Malik
/** Everybody who gets a scorecard (everybody but the CEO / Founder / Owner, who has no manager). */
const SCORED = ['ACV-0003', 'ACV-0004', 'ACV-0006', 'ACV-0007', 'ACV-0008', 'ACV-0009', 'ACV-0010', 'ACV-0011', 'ACV-0012', 'ACV-0013', 'ACV-0014'];
const SALES_STAFF = ['ACV-0009', 'ACV-0012', 'ACV-0014'];
const HOUR = 3_600_000;
const OMAR = 'omar@acevatech.com';
const BILAL = 'bilal@acevatech.com';
const MARIAM = 'mariam@acevatech.com';

let t: TestApp;
let prisma: PrismaClient;
let prismaService: PrismaService;
let monthly: ScorecardMonthly;
let jobs: JobRunner;
let dispatcher: OutboxDispatcher;
let outbox: OutboxService;
let audit: AuditService;
let directory: PerformanceDirectory;
let mail: PerformanceMail;
let env: Env;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestApp();
  prisma = createTestPrisma();
  prismaService = t.app.get(PrismaService);
  monthly = t.app.get(ScorecardMonthly);
  jobs = t.app.get(JobRunner);
  dispatcher = t.app.get(OutboxDispatcher);
  outbox = t.app.get(OutboxService);
  audit = t.app.get(AuditService);
  directory = t.app.get(PerformanceDirectory);
  mail = t.app.get(PerformanceMail);
  env = t.app.get<Env>(ENV);
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
});
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

// ------------------------------------------------------------------------------------------------------------ helpers

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A moment in Pakistan time (UTC+5, no daylight saving). */
const pk = (day: string, time = '12:00') => new Date(`${day}T${time}:00+05:00`);
/** Moves the fake clock to a moment (it keeps running from there). */
function setClock(at: Date): void {
  t.clock.advance(at.getTime() - t.clock.now().getTime());
}

/** Runs every job that is due and waits until the job runner's own 30-second timer (if it is running) has finished too. */
async function runDueJobs(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await jobs.tick();
    const busy = await prisma.scheduledJob.count({ where: { OR: [{ status: 'pending', runAt: { lte: t.clock.now() } }, { status: 'running' }] } });
    if (!busy) return;
    await sleep(100);
  }
  throw new Error('The jobs did not finish');
}

/** Delivers what is waiting in the outbox, then forgets the mails (so a test sees only its own). */
async function flushMails(): Promise<void> {
  await dispatcher.tick();
  t.mailer.clear();
}

/** The mails with this subject, optionally to one address. */
const mailsWith = (subject: string, to?: string) => t.mailer.sent.filter((m) => m.subject === subject && (!to || m.to === to));
const mailList = () => t.mailer.sent.map((m) => `${m.to} | ${m.subject}`).sort();

let seq = 9100;
interface TaskSpec {
  assignee: string;
  deadline: Date;
  points: number;
  status?: 'approved' | 'in_progress' | 'cancelled' | 'submitted' | 'under_review';
  rating?: number;
  /** Handed in after the deadline. */
  late?: boolean;
  reworks?: number;
  personal?: boolean;
  /** When it was handed in (default: two hours before or, with `late`, after the deadline). */
  submittedAt?: Date;
  /** The deadline the task was first given (default: the same as `deadline`). */
  originalDeadline?: Date;
  extensionsCount?: number;
  /** Default 20 September 2026; a task due in an earlier month needs an earlier start. */
  startDate?: Date;
}

/**
 * A task of the month, written straight into the tables, with the reviewer's approval when it is approved and rated. A task
 * that is 'submitted' or 'under_review' was handed in and is waiting for its reviewer (no review row).
 */
async function makeTask(s: TaskSpec) {
  const personal = s.personal ?? false;
  const status = s.status ?? 'approved';
  const handedIn = status === 'approved' || status === 'submitted' || status === 'under_review';
  const submittedAt = handedIn ? (s.submittedAt ?? new Date(s.deadline.getTime() + (s.late ? 2 : -2) * HOUR)) : null;
  const row = await prisma.task.create({
    data: {
      number: personal ? `TODO-${++seq}` : `TSK-${++seq}`,
      title: personal ? 'Tidy my notes' : 'Fix login bug',
      assigneeId: ids[s.assignee],
      assignedById: personal ? ids[s.assignee] : ids[CTO],
      size: 'M',
      points: s.points,
      estimatedHours: 16,
      startDate: s.startDate ?? new Date('2026-09-20T04:00:00Z'),
      deadline: s.deadline,
      originalDeadline: s.originalDeadline ?? s.deadline,
      status,
      personal,
      reworkCount: s.reworks ?? 0,
      extensionsCount: s.extensionsCount ?? 0,
      submittedAt,
      closedAt: status === 'in_progress' || status === 'submitted' || status === 'under_review' ? null : s.deadline,
    } as never,
  });
  if (status === 'approved' && s.rating) {
    await prisma.taskReview.create({ data: { taskId: row.id, reviewerId: ids[CTO], decision: 'approved', rating: s.rating, submittedAt, deadlineAtReview: s.deadline } });
  }
  return row;
}

/** The scorecards of a month by the person's Emp-ID, with what the tests read. */
async function cardsOf(month: string) {
  const rows = await prisma.scorecard.findMany({
    where: { month },
    include: { employee: { select: { empId: true } }, reviewer: { select: { empId: true } }, releasedBy: { select: { empId: true } }, tasks: { orderBy: { position: 'asc' } } },
    orderBy: { employee: { empId: 'asc' } },
  });
  return new Map(rows.map((r) => [r.employee.empId, r]));
}
type Card = Awaited<ReturnType<typeof cardsOf>> extends Map<string, infer V> ? V : never;
const scoreOf = (c: Card) => (c.score === null ? null : Number(c.score));

/** Everything about a month's scorecards that must never change once they exist. */
async function frozen(month: string) {
  return [...(await cardsOf(month)).values()].map((s) => ({
    id: s.id,
    empId: s.employee.empId,
    status: s.status,
    score: scoreOf(s),
    band: s.band,
    metrics: s.metrics,
    unmeasured: s.unmeasured,
    taskCount: s.taskCount,
    weightsVersionId: s.weightsVersionId,
    reviewer: s.reviewer?.empId ?? null,
    updatedAt: s.updatedAt.toISOString(),
    tasks: s.tasks.map((x) => [x.number, x.title, x.rating, x.status, x.counted, x.onTime, x.reworked]),
  }));
}

const eventsOf = async (type: string, month: string) => (await prisma.outboxEvent.findMany({ where: { type }, orderBy: { occurredAt: 'asc' } })).filter((e) => (e.payload as { month: string }).month === month);
const auditOf = async (action: string, month: string) => (await prisma.auditLog.findMany({ where: { action }, orderBy: { occurredAt: 'asc' } })).filter((a) => (a.details as unknown as { month?: string } | null)?.month === month);

/** A scorecard monthly service wired like the app's but with another calculator (to fail for one person, or to plug in real sources). */
const makeMonthly = (calculator: PerformanceCalculator) => new ScorecardMonthly(prismaService, jobs, t.clock, directory, calculator, outbox, audit, mail, env);

// The tasks every test below reads. Mariam's October is the worked example of the plan: ratings 5,4,3,4,5 on points 3,2,5,1,3, one hand-in
// late, one task sent back: Q 81.4, T 80, C 100, R 20 (attendance not available) = score 85.
const fx: Record<string, Awaited<ReturnType<typeof makeTask>>> = {};
beforeAll(async () => {
  // 00:30 on 1 October Pakistan time is still 30 September in UTC: it belongs to OCTOBER
  fx.t1 = await makeTask({ assignee: DEV2, points: 3, rating: 5, deadline: pk('2026-10-01', '00:30') });
  fx.t2 = await makeTask({ assignee: DEV2, points: 2, rating: 4, late: true, deadline: pk('2026-10-08') });
  fx.t3 = await makeTask({ assignee: DEV2, points: 5, rating: 3, reworks: 1, deadline: pk('2026-10-12') });
  fx.t4 = await makeTask({ assignee: DEV2, points: 1, rating: 4, deadline: pk('2026-10-15') });
  fx.cancelled = await makeTask({ assignee: DEV2, points: 5, status: 'cancelled', deadline: pk('2026-10-18') });
  fx.t5 = await makeTask({ assignee: DEV2, points: 3, rating: 5, deadline: pk('2026-10-20') });
  fx.todo = await makeTask({ assignee: DEV2, points: 0, personal: true, deadline: pk('2026-10-10') });
  // 00:30 on 1 November Pakistan time is still 31 October in UTC: it belongs to NOVEMBER
  fx.nov = await makeTask({ assignee: DEV2, points: 3, rating: 1, deadline: pk('2026-11-01', '00:30') });
  // Ali: one task, overdue and still open: it counts (completion 0), nothing else can be measured
  fx.open = await makeTask({ assignee: DEV3, points: 3, status: 'in_progress', deadline: pk('2026-10-10') });
});

// ------------------------------------------------------------------------------------------------------------ scheduling

describe('scheduling the monthly job', () => {
  it('nothing is scheduled by itself while background work is off; ensureScheduled makes the job of the month that just closed (due now) and of the current month (due on the 1st), once', async () => {
    expect(await prisma.scheduledJob.count({ where: { type: 'scorecard.monthly' } })).toBe(0);
    const at = pk('2026-11-17', '09:00');
    setClock(at);
    t.mailer.clear();

    expect(await monthly.ensureScheduled()).toBe(2);
    const rows = await prisma.scheduledJob.findMany({ where: { type: 'scorecard.monthly' }, orderBy: { dedupeKey: 'asc' } });
    expect(rows.map((r) => r.dedupeKey)).toEqual(['scorecard.monthly:2026-10', 'scorecard.monthly:2026-11']);
    expect(rows.map((r) => r.payload)).toEqual([{ month: '2026-10' }, { month: '2026-11' }]);
    expect(rows.every((r) => r.status === 'pending' && r.createdBy === null)).toBe(true);
    // October closed two weeks ago: catching up, so it is due now. November is due at 00:10 Pakistan time on 1 December.
    expect(rows[0].runAt.getTime()).toBeGreaterThanOrEqual(at.getTime());
    expect(rows[0].runAt.getTime()).toBeLessThanOrEqual(t.clock.now().getTime());
    expect(rows[1].runAt.toISOString()).toBe('2026-11-30T19:10:00.000Z');
    expect(rows[1].runAt.getTime()).toBe(pk('2026-12-01', '00:10').getTime());

    // asking again, or from a second server, makes nothing twice
    expect(await monthly.ensureScheduled()).toBe(0);
    expect(await prisma.scheduledJob.count({ where: { type: 'scorecard.monthly' } })).toBe(2);
  });

  it('the app uses the stand-ins for attendance and sales until Modules 7 and 15 replace them', () => {
    expect(t.app.get(ATTENDANCE_SOURCE)).toBeInstanceOf(NotBuiltAttendanceSource);
    expect(t.app.get(SALES_SOURCE)).toBeInstanceOf(NotBuiltSalesSource);
  });
});

// ------------------------------------------------------------------------------------------------------------ the October run

describe('the October run, through the job runner', () => {
  const OCT = '2026-10';

  it('makes a scorecard for everybody but the Owner, with the reviewer, the weights version and the kind of each person', async () => {
    await runDueJobs();
    const job = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: 'scorecard.monthly:2026-10' } });
    expect(job).toMatchObject({ status: 'succeeded', attempts: 1, lastError: null });

    const cards = await cardsOf(OCT);
    expect([...cards.keys()].sort()).toEqual(SCORED);
    expect(cards.has(OWNER)).toBe(false);

    const reviewers: Record<string, string | null> = {
      'ACV-0003': null, // the Director: the Owner reviews nothing
      'ACV-0004': DIRECTOR,
      'ACV-0006': CTO,
      'ACV-0007': CTO,
      'ACV-0008': CTO,
      'ACV-0009': DIRECTOR,
      'ACV-0010': DIRECTOR,
      'ACV-0011': CTO,
      'ACV-0012': DIRECTOR,
      'ACV-0013': CTO,
      'ACV-0014': DIRECTOR,
    };
    const standardV1 = await prisma.scoreWeightVersion.findFirstOrThrow({ where: { kind: 'standard', departmentId: null, versionNo: 1 } });
    const salesV1 = await prisma.scoreWeightVersion.findFirstOrThrow({ where: { kind: 'sales', departmentId: null, versionNo: 1 } });
    for (const [empId, card] of cards) {
      expect(card.reviewer?.empId ?? null, `reviewer of ${empId}`).toBe(reviewers[empId]);
      expect(card.kind, `kind of ${empId}`).toBe(SALES_STAFF.includes(empId) ? 'sales' : 'standard');
      expect(card.weightsVersionId, `weights of ${empId}`).toBe(SALES_STAFF.includes(empId) ? salesV1.id : standardV1.id);
      expect(card.createdAt.getTime()).toBeGreaterThanOrEqual(pk('2026-11-17', '09:00').getTime());
      if (empId === DIRECTOR) continue;
      expect(card, `${empId} is a draft`).toMatchObject({ status: 'draft', releasedAt: null, acknowledgedAt: null, recomputeCount: 0 });
      expect(card.releasedBy).toBeNull();
    }
  }, 60000);

  it('the Director\'s scorecard has no reviewer and is released at once by the system (nobody released it)', async () => {
    const director = (await cardsOf(OCT)).get(DIRECTOR)!;
    expect(director).toMatchObject({ status: 'released', reviewerId: null, releasedById: null });
    expect(director.releasedAt).not.toBeNull();
    expect(director.releasedAt?.getTime()).toBe(director.createdAt.getTime());
    expect(director.acknowledgedAt).toBeNull();
  });

  it('works the plan\'s numbers out from the tasks: only the tasks due in the Pakistan month, cancelled ones listed but not counted, no personal to-do', async () => {
    const mariam = (await cardsOf(OCT)).get(DEV2)!;
    expect(mariam.metrics).toEqual({ quality: 81.4, onTime: 80, completion: 100, rework: 20, attendance: null, workloadHours: 0 });
    expect(scoreOf(mariam)).toBe(85);
    expect(mariam.band).toBe('excellent');
    expect(mariam).toMatchObject({ taskCount: 5, smallSample: false });
    expect(mariam.unmeasured).toEqual([{ key: 'attendance', reason: 'attendance_not_available' }]);
    expect(mariam.salesDetail).toBeNull();

    // the snapshot: ordered by deadline; the 00:30 task of 1 October is in, the 00:30 task of 1 November is not, nor is the personal to-do
    expect(mariam.tasks.map((x) => [x.number, x.counted, x.status, x.rating])).toEqual([
      [fx.t1.number, true, 'approved', 5],
      [fx.t2.number, true, 'approved', 4],
      [fx.t3.number, true, 'approved', 3],
      [fx.t4.number, true, 'approved', 4],
      [fx.cancelled.number, false, 'cancelled', null],
      [fx.t5.number, true, 'approved', 5],
    ]);
    expect(mariam.tasks.find((x) => x.number === fx.t2.number)).toMatchObject({ onTime: false, reworked: false });
    expect(mariam.tasks.find((x) => x.number === fx.t3.number)).toMatchObject({ onTime: true, reworked: true });
    expect(mariam.tasks.map((x) => x.number)).not.toContain(fx.nov.number);
    expect(mariam.tasks.map((x) => x.number)).not.toContain(fx.todo.number);
  });

  it('an open task that is overdue counts once its deadline passed; a person with nothing to measure gets no score, not a made-up one', async () => {
    const cards = await cardsOf(OCT);
    const ali = cards.get(DEV3)!;
    expect(ali.metrics).toEqual({ quality: null, onTime: null, completion: 0, rework: null, attendance: null, workloadHours: 16 });
    expect(scoreOf(ali)).toBe(0);
    expect(ali.band).toBe('poor');
    expect(ali).toMatchObject({ taskCount: 1, smallSample: true });
    expect(ali.unmeasured).toEqual([
      { key: 'quality', reason: 'nothing_to_measure' },
      { key: 'onTime', reason: 'nothing_to_measure' },
      { key: 'rework', reason: 'nothing_to_measure' },
      { key: 'attendance', reason: 'attendance_not_available' },
    ]);

    const fahad = cards.get(DEV1)!;
    expect(fahad.metrics).toEqual({ quality: null, onTime: null, completion: null, rework: null, attendance: null, workloadHours: 0 });
    expect(fahad.score).toBeNull();
    expect(fahad.band).toBeNull();
    expect(fahad).toMatchObject({ taskCount: 0, smallSample: true });
    expect(fahad.tasks).toEqual([]);
  });

  it('attendance and sales are never invented: every attendance is null, and a sales scorecard has no sales figures and NO score', async () => {
    const cards = await cardsOf(OCT);
    for (const [empId, card] of cards) {
      expect((card.metrics as { attendance: number | null }).attendance, `attendance of ${empId}`).toBeNull();
      expect(card.unmeasured as unknown as Array<{ key: string; reason: string }>).toContainEqual({ key: 'attendance', reason: 'attendance_not_available' });
    }
    for (const empId of SALES_STAFF) {
      const card = cards.get(empId)!;
      expect(card.kind).toBe('sales');
      expect(card.metrics).toEqual({ activity: null, meetings: null, won: null, dataQuality: null, attendance: null });
      expect(card.salesDetail).toBeNull();
      expect(card.score).toBeNull();
      expect(card.band).toBeNull();
      expect(card).toMatchObject({ taskCount: 0, smallSample: false });
      expect(card.unmeasured).toEqual([
        { key: 'activity', reason: 'sales_not_available' },
        { key: 'meetings', reason: 'sales_not_available' },
        { key: 'won', reason: 'sales_not_available' },
        { key: 'dataQuality', reason: 'sales_not_available' },
        { key: 'attendance', reason: 'attendance_not_available' },
      ]);
    }
  });

  it('writes the audit entries (actor: nobody) and the events (actor: system); the Director\'s release is automatic', async () => {
    const drafted = await auditOf('scorecard.drafted', OCT);
    expect(drafted).toHaveLength(11);
    expect(drafted.every((a) => a.actorId === null && a.targetType === 'scorecard' && a.outcome === 'success')).toBe(true);
    const cards = await cardsOf(OCT);
    // One target format for every scorecard audit row (the services use it too): "<Emp-ID> <month>"; the scorecard id is in the details.
    expect(new Set(drafted.map((a) => a.targetId))).toEqual(new Set([...cards.keys()].map((empId) => `${empId} ${OCT}`)));
    expect(drafted.find((a) => a.targetId === `${DEV2} ${OCT}`)!.details).toMatchObject({ employee: DEV2, reviewer: CTO, kind: 'standard', taskCount: 5, scorecardId: cards.get(DEV2)!.id });
    const released = await auditOf('scorecard.released', OCT);
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ actorId: null, targetId: `${DIRECTOR} ${OCT}` });
    expect(released[0].details).toMatchObject({ employee: DIRECTOR, automatic: true, scorecardId: cards.get(DIRECTOR)!.id });
    expect(released[0].reason).toContain('no reviewer');

    const events = await eventsOf('scorecard.drafted', OCT);
    expect(events).toHaveLength(11);
    expect(events.every((e) => e.actor === 'system' && e.version === 1)).toBe(true);
    const mariam = events.find((e) => (e.payload as { empId: string }).empId === DEV2)!;
    expect(mariam.payload).toMatchObject({ scorecardId: cards.get(DEV2)!.id, kind: 'standard', reviewer: CTO, score: 85, taskCount: 5, smallSample: false });
    expect(events.find((e) => (e.payload as { empId: string }).empId === DIRECTOR)!.payload).toMatchObject({ reviewer: null });
    expect(events.find((e) => (e.payload as { empId: string }).empId === SALES1)!.payload).toMatchObject({ kind: 'sales', reviewer: DIRECTOR, score: null });

    const releasedEvents = await eventsOf('scorecard.released', OCT);
    expect(releasedEvents).toHaveLength(1);
    expect(releasedEvents[0].actor).toBe('system');
    expect(releasedEvents[0].payload).toMatchObject({ empId: DIRECTOR, releasedBy: null, automatic: true, hasRemark: false, scorecardId: cards.get(DIRECTOR)!.id });
  });

  it('mails each reviewer ONE mail for all their drafts, and the Director that their own scorecard was released; nobody else', async () => {
    await dispatcher.tick();
    expect(mailList()).toEqual([`${BILAL} | 5 draft scorecards to review: October 2026`, `${BILAL} | Your October 2026 scorecard is ready`, `${OMAR} | 5 draft scorecards to review: October 2026`]);

    const digest = mailsWith('5 draft scorecards to review: October 2026', OMAR)[0];
    expect(digest.text).toContain('Hello Omar Farooq,');
    expect(digest.text).toContain('You have 5 draft scorecards for October 2026 to review and release.');
    expect(digest.text).toContain(`${env.APP_URL}/approvals`);
    expect(digest.html).toContain('<a href=');

    const cards = await cardsOf(OCT);
    const released = mailsWith('Your October 2026 scorecard is ready', BILAL)[0];
    expect(released.text).toContain('Your scorecard for October 2026 was released.');
    expect(released.text).toContain(`${env.APP_URL}/performance/scorecards/${cards.get(DIRECTOR)!.id}`);
    // a mail never carries the score
    for (const m of t.mailer.sent) expect(m.text).not.toMatch(/score of|points/i);
  });
});

// ------------------------------------------------------------------------------------------------------------ idempotent

describe('running a month again never duplicates or overwrites anything', () => {
  const OCT = '2026-10';

  it('a second run changes nothing: same scorecards, no new audit entries or events, no mails', async () => {
    const before = await frozen(OCT);
    const counts = async () => [await prisma.scorecard.count(), await prisma.scorecardTask.count(), await prisma.auditLog.count({ where: { action: { startsWith: 'scorecard.' } } }), await prisma.outboxEvent.count({ where: { type: { startsWith: 'scorecard.' } } })];
    const countsBefore = await counts();
    await flushMails();

    expect(await monthly.run(OCT)).toEqual({ month: OCT, created: 0, existing: 11, autoReleased: 0, failed: 0 });
    await dispatcher.tick();

    expect(await frozen(OCT)).toEqual(before);
    expect(await counts()).toEqual(countsBefore);
    expect(t.mailer.sent).toHaveLength(0);
  }, 60000);

  it('a scorecard never changes when the tasks change later, even if the month is run again at a later time', async () => {
    const before = await frozen(OCT);
    // the tasks move on: a new, lower approval, a new title, a task cancelled afterwards
    await prisma.taskReview.create({ data: { taskId: fx.t1.id, reviewerId: ids[CTO], decision: 'approved', rating: 1, submittedAt: new Date(), deadlineAtReview: fx.t1.deadline } });
    await prisma.task.update({ where: { id: fx.t2.id }, data: { title: 'Renamed later', reworkCount: 3 } });
    await prisma.task.update({ where: { id: fx.t4.id }, data: { status: 'cancelled' } });

    expect(await monthly.run(OCT, pk('2026-11-25'))).toMatchObject({ created: 0, existing: 11, failed: 0 });
    expect(await frozen(OCT)).toEqual(before);
    const mariam = (await cardsOf(OCT)).get(DEV2)!;
    expect(scoreOf(mariam)).toBe(85);
    expect(mariam.tasks.find((x) => x.number === fx.t2.number)!.title).toBe('Fix login bug');
  }, 60000);

  it('two runs at the same moment (two servers) make each scorecard once', async () => {
    const month = '2026-02'; // everybody joined on 5 January: a month nobody has a scorecard for yet
    const [a, b] = await Promise.all([monthly.run(month, pk('2026-11-17')), monthly.run(month, pk('2026-11-17'))]);
    expect(a.failed + b.failed).toBe(0);
    expect(a.created + b.created).toBe(11);
    expect(a.created + a.existing).toBe(11);
    expect(b.created + b.existing).toBe(11);
    expect(await prisma.scorecard.count({ where: { month } })).toBe(11);
    expect(await prisma.scorecardTask.count({ where: { scorecard: { month } } })).toBe(0);
    expect(await eventsOf('scorecard.drafted', month)).toHaveLength(11);
    expect(await eventsOf('scorecard.released', month)).toHaveLength(1);
    expect(await auditOf('scorecard.drafted', month)).toHaveLength(11);
    await flushMails();
  }, 60000);
});

// ------------------------------------------------------------------------------------------------------------ a person fails

describe('one person cannot be scored: the others still get theirs, the job fails to be retried, the retry makes only the missing one', () => {
  const SEP = '2026-09';

  it('counts the failure, mails the reviewers for what was made, throws at the end; the retry makes exactly the missing scorecard and mails only its reviewer', async () => {
    const real = t.app.get(PerformanceCalculator);
    let failFor: string | null = DEV3;
    const flaky = {
      compute: async (...args: Parameters<PerformanceCalculator['compute']>) => {
        if (args[0].empId === failFor) throw new Error('The attendance store is down');
        return real.compute(...args);
      },
    } as unknown as PerformanceCalculator;
    const run = makeMonthly(flaky);
    await flushMails();

    await expect(run.run(SEP, pk('2026-11-17'))).rejects.toThrow('1 scorecard of 2026-09 could not be made (10 were)');
    const cards = await cardsOf(SEP);
    expect(cards.size).toBe(10);
    expect(cards.has(DEV3)).toBe(false);
    expect(mailList()).toEqual([`${BILAL} | 5 draft scorecards to review: September 2026`, `${OMAR} | 4 draft scorecards to review: September 2026`]);

    failFor = null;
    t.mailer.clear();
    expect(await run.run(SEP, pk('2026-11-17'))).toEqual({ month: SEP, created: 1, existing: 10, autoReleased: 0, failed: 0 });
    expect((await cardsOf(SEP)).get(DEV3)).toMatchObject({ status: 'draft' });
    // only the reviewer who got a new draft is mailed again; the count is what waits for them now (the four from before and this one)
    expect(mailList()).toEqual([`${OMAR} | 5 draft scorecards to review: September 2026`]);
    expect(await eventsOf('scorecard.drafted', SEP)).toHaveLength(11);
    expect(await eventsOf('scorecard.released', SEP)).toHaveLength(1);
    await flushMails();
  }, 60000);
});

// ------------------------------------------------------------------------------------------------------------ mail server down

describe('a mail server that is down', () => {
  it('does not fail the run or undo anything: the drafts exist (and wait in the approvals inbox); the run is not repeated for a mail', async () => {
    const MAY = '2026-05';
    await flushMails();
    t.mailer.failing = true;
    const result = await monthly.run(MAY, pk('2026-11-17')).finally(() => {
      t.mailer.failing = false;
    });
    expect(result).toEqual({ month: MAY, created: 11, existing: 0, autoReleased: 1, failed: 0 });
    expect(await prisma.scorecard.count({ where: { month: MAY } })).toBe(11);
    expect(t.mailer.sent).toHaveLength(0);
    await flushMails();
  }, 60000);
});

// ------------------------------------------------------------------------------------------------------------ real sources plug in

describe('a real attendance source and a real sales source plug in with no change to the job', () => {
  const MAR = '2026-03';
  const detail: SalesDetail = { targetDaysMet: 15, workingDays: 20, meetings: 8, meetingTarget: 10, wonValueUsd: 9000, wonTargetUsd: 10000, bounceRate: 3, duplicates: 0 };

  it('uses the attendance percentage and the sales figures it is given, and works the sales score out from them', async () => {
    const attendance: AttendanceSource = { rateFor: async () => ({ available: true, rate: 90 }) };
    const sales: SalesSource = { figuresFor: async () => ({ available: true, detail }) };
    const run = makeMonthly(new PerformanceCalculator(prismaService, attendance, sales));
    await flushMails();
    expect(await run.run(MAR, pk('2026-11-17'))).toMatchObject({ created: 11, failed: 0 });

    const cards = await cardsOf(MAR);
    // a standard person with no tasks: attendance alone is measured, so it is the score (its weight shared among the measured: nothing else)
    const fahad = cards.get(DEV1)!;
    expect(fahad.metrics).toEqual({ quality: null, onTime: null, completion: null, rework: null, attendance: 90, workloadHours: 0 });
    expect(fahad.unmeasured).toEqual([
      { key: 'quality', reason: 'nothing_to_measure' },
      { key: 'onTime', reason: 'nothing_to_measure' },
      { key: 'completion', reason: 'nothing_to_measure' },
      { key: 'rework', reason: 'nothing_to_measure' },
    ]);
    expect(scoreOf(fahad)).toBe(90);
    expect(fahad.band).toBe('excellent');

    // a salesperson: V 75, M 80, W 90, D 100, A 90 = 0.20 x 75 + 0.25 x 80 + 0.30 x 90 + 0.10 x 100 + 0.15 x 90 = 85.5
    const hira = cards.get(SALES1)!;
    expect(hira.kind).toBe('sales');
    expect(hira.metrics).toEqual({ activity: 75, meetings: 80, won: 90, dataQuality: 100, attendance: 90 });
    expect(hira.salesDetail).toEqual(detail);
    expect(hira.unmeasured).toEqual([]);
    expect(scoreOf(hira)).toBe(85.5);
    expect(hira.band).toBe('excellent');
    expect(hira).toMatchObject({ taskCount: 20, smallSample: false });
    await flushMails();
  }, 60000);

  it('a source that fails (a real fault) is not stored as "not available": that person gets no scorecard and the job is retried', async () => {
    const down: AttendanceSource = {
      rateFor: async (employeeId) => {
        if (employeeId === ids[DEV1]) throw new Error('Attendance store unreachable');
        return { available: false };
      },
    };
    const run = makeMonthly(new PerformanceCalculator(prismaService, down, new NotBuiltSalesSource()));
    const month = '2026-04';
    await expect(run.run(month, pk('2026-11-17'))).rejects.toThrow('1 scorecard of 2026-04 could not be made');
    expect((await cardsOf(month)).has(DEV1)).toBe(false);
    expect((await cardsOf(month)).size).toBe(10);
    await flushMails();
  }, 60000);
});

// ------------------------------------------------------------------------------------------------------------ what the month cannot judge yet

describe('June: tasks still waiting for review when the month is measured, and an extension asked for after the deadline', () => {
  const JUN = '2026-06';
  const START = new Date('2026-05-25T04:00:00Z');
  const task: Record<string, Awaited<ReturnType<typeof makeTask>>> = {};

  beforeAll(async () => {
    // Fahad: one approved and rated task, one in review (handed in on time), one handed in on time on the last working day: nothing reviewed yet
    task.approved = await makeTask({ assignee: DEV1, points: 3, rating: 5, deadline: pk('2026-06-03', '18:00'), startDate: START });
    task.review = await makeTask({ assignee: DEV1, points: 5, status: 'under_review', deadline: pk('2026-06-10', '18:00'), startDate: START });
    task.waiting = await makeTask({ assignee: DEV1, points: 2, status: 'submitted', deadline: pk('2026-06-26', '18:00'), startDate: START });
    // Ali: due 10 June, an extension asked for on the 12th (after the deadline) was approved to the 15th, handed in on the 14th: still late
    task.lateExt = await makeTask({
      assignee: DEV3,
      points: 3,
      rating: 4,
      deadline: pk('2026-06-15', '18:00'),
      originalDeadline: pk('2026-06-10', '18:00'),
      submittedAt: pk('2026-06-14', '17:00'),
      extensionsCount: 1,
      startDate: START,
    });
    await prisma.taskExtension.create({
      data: {
        taskId: task.lateExt.id,
        requestedById: ids[DEV3],
        currentDeadline: pk('2026-06-10', '18:00'),
        requestedDeadline: pk('2026-06-15', '18:00'),
        reason: 'The server was down',
        status: 'approved',
        late: true,
        decidedById: ids[CTO],
        decidedAt: pk('2026-06-12', '15:00'),
        createdAt: pk('2026-06-12', '09:00'),
      },
    });
    // Ali: due 12 June, an extension asked for on the 11th (in time) was approved to the 16th, handed in on the 15th: on time
    task.inTimeExt = await makeTask({
      assignee: DEV3,
      points: 2,
      rating: 5,
      deadline: pk('2026-06-16', '18:00'),
      originalDeadline: pk('2026-06-12', '18:00'),
      submittedAt: pk('2026-06-15', '17:00'),
      extensionsCount: 1,
      startDate: START,
    });
    await prisma.taskExtension.create({
      data: {
        taskId: task.inTimeExt.id,
        requestedById: ids[DEV3],
        currentDeadline: pk('2026-06-12', '18:00'),
        requestedDeadline: pk('2026-06-16', '18:00'),
        reason: 'Waiting for the client',
        status: 'approved',
        late: false,
        decidedById: ids[CTO],
        decidedAt: pk('2026-06-11', '15:00'),
        createdAt: pk('2026-06-11', '09:00'),
      },
    });
  });

  it('a task waiting for review at 00:10 on the 1st is stored as waiting: it counts as handed in and in the points due, but earns no points and no rating, and a later approval changes nothing', async () => {
    await flushMails();
    expect(await monthly.run(JUN, pk('2026-07-01', '00:10'))).toMatchObject({ month: JUN, created: 11, existing: 0, failed: 0 });

    // Q only from the one rated task (5 stars = 100); T all three handed in on time = 100; C 3 of 10 points = 30; R 0
    // score (35 x 100 + 25 x 100 + 20 x 30 + 10 x 100) / 90 = 84.4
    const fahad = (await cardsOf(JUN)).get(DEV1)!;
    expect(fahad.metrics).toMatchObject({ quality: 100, onTime: 100, completion: 30, rework: 0, attendance: null });
    expect(scoreOf(fahad)).toBe(84.4);
    expect(fahad).toMatchObject({ band: 'good', taskCount: 3, smallSample: true, status: 'draft' });
    const stored = (number: string) => fahad.tasks.find((x) => x.number === number)!;
    expect(stored(task.approved.number)).toMatchObject({ status: 'approved', rating: 5, counted: true, onTime: true });
    expect(stored(task.review.number)).toMatchObject({ status: 'submitted', rating: null, counted: true, onTime: true });
    expect(stored(task.waiting.number)).toMatchObject({ status: 'submitted', rating: null, counted: true, onTime: true });

    // the reviewer clears the queue on the 1st and the 2nd: the scorecard is a snapshot and stays as it was
    const before = await frozen(JUN);
    for (const [row, rating] of [[task.review, 5], [task.waiting, 4]] as const) {
      await prisma.task.update({ where: { id: row.id }, data: { status: 'approved', closedAt: pk('2026-07-02') } });
      await prisma.taskReview.create({ data: { taskId: row.id, reviewerId: ids[CTO], decision: 'approved', rating, submittedAt: row.submittedAt, deadlineAtReview: row.deadline } });
    }
    expect(await monthly.run(JUN, pk('2026-07-02', '10:00'))).toMatchObject({ created: 0, existing: 11, failed: 0 });
    expect(await frozen(JUN)).toEqual(before);
    expect(scoreOf((await cardsOf(JUN)).get(DEV1)!)).toBe(84.4);
    await flushMails();
  }, 60000);

  it('an extension asked for after the deadline counts as late: the task stays late although it was handed in before the new deadline; an extension asked for in time is not late', async () => {
    // Q (4 x 3 + 5 x 2) / 5 x 20 = 88; T 1 of 2 on time = 50; C 100; R 0; score (35 x 88 + 25 x 50 + 20 x 100 + 10 x 100) / 90 = 81.4
    const ali = (await cardsOf(JUN)).get(DEV3)!;
    expect(ali.metrics).toMatchObject({ quality: 88, onTime: 50, completion: 100, rework: 0, attendance: null });
    expect(scoreOf(ali)).toBe(81.4);
    const stored = (number: string) => ali.tasks.find((x) => x.number === number)!;
    expect(stored(task.lateExt.number)).toMatchObject({ onTime: false, extensions: 1, status: 'approved', rating: 4 });
    expect(stored(task.inTimeExt.number)).toMatchObject({ onTime: true, extensions: 1, status: 'approved', rating: 5 });
  }, 60000);
});

// ------------------------------------------------------------------------------------------------------------ weights versions, November

describe('the November run: the weights version in force for the person\'s kind and department, and the month boundary', () => {
  const NOV = '2026-11';

  it('uses the department\'s own newest set, else the company-wide newest set, and old scorecards keep their version', async () => {
    const dept = await prisma.department.findUniqueOrThrow({ where: { code: 'dep-eng' }, select: { id: true } });
    const standardV1 = await prisma.scoreWeightVersion.findFirstOrThrow({ where: { kind: 'standard', departmentId: null, versionNo: 1 } });
    const companyV2 = await prisma.scoreWeightVersion.create({
      data: { kind: 'standard', departmentId: null, versionNo: 2, weights: { quality: 40, onTime: 20, completion: 20, rework: 10, attendance: 10 }, note: 'Company-wide', createdById: ids[DIRECTOR] },
    });
    const engV1 = await prisma.scoreWeightVersion.create({
      data: { kind: 'standard', departmentId: dept.id, versionNo: 1, weights: { quality: 20, onTime: 20, completion: 20, rework: 20, attendance: 20 }, note: 'Engineering', createdById: ids[DIRECTOR] },
    });
    const salesV1 = await prisma.scoreWeightVersion.findFirstOrThrow({ where: { kind: 'sales', departmentId: null, versionNo: 1 } });
    await flushMails();

    // the run for November happens on 1 December (00:10 Pakistan time)
    expect(await monthly.run(NOV, pk('2026-12-01', '00:10'))).toEqual({ month: NOV, created: 11, existing: 0, autoReleased: 1, failed: 0 });
    const cards = await cardsOf(NOV);
    const people = await prisma.employee.findMany({ where: { empId: { in: SCORED } }, select: { empId: true, department: { select: { code: true } } } });
    const departmentOf = new Map(people.map((p) => [p.empId, p.department.code]));
    for (const [empId, card] of cards) {
      const expected = SALES_STAFF.includes(empId) ? salesV1.id : departmentOf.get(empId) === 'dep-eng' ? engV1.id : companyV2.id;
      expect(card.weightsVersionId, `weights of ${empId}`).toBe(expected);
    }
    expect(cards.get(DIRECTOR)!.weightsVersionId).toBe(companyV2.id);
    expect(cards.get(FINANCE)!.weightsVersionId).toBe(companyV2.id);
    expect(cards.get(CTO)!.weightsVersionId).toBe(engV1.id);

    // October was made with version 1 and keeps it, and its numbers
    const october = await cardsOf('2026-10');
    for (const [empId, card] of october) if (!SALES_STAFF.includes(empId)) expect(card.weightsVersionId, `October weights of ${empId}`).toBe(standardV1.id);
    expect(scoreOf(october.get(DEV2)!)).toBe(85);

    // Mariam's November: only the task due at 00:30 on 1 November (rated 1): Q 20, T 100, C 100, R 0 (used as 100); Engineering weights 20 each over the
    // four measured = 0.25 x (20 + 100 + 100 + 100) = 80
    const mariam = cards.get(DEV2)!;
    expect(mariam.metrics).toEqual({ quality: 20, onTime: 100, completion: 100, rework: 0, attendance: null, workloadHours: 0 });
    expect(scoreOf(mariam)).toBe(80);
    expect(mariam.band).toBe('good');
    expect(mariam).toMatchObject({ taskCount: 1, smallSample: true });
    expect(mariam.tasks.map((x) => x.number)).toEqual([fx.nov.number]);
    await flushMails();
  }, 60000);
});

// ------------------------------------------------------------------------------------------------------------ the mails of the consumers

describe('the performance mails (consumer "performance.mail")', () => {
  async function releasedRow(scorecardId: string) {
    return prisma.scorecard.findUniqueOrThrow({ where: { id: scorecardId }, include: SCORECARD_INCLUDE });
  }
  const disputeRow = (id: string) => prisma.ratingDispute.findUniqueOrThrow({ where: { id }, include: DISPUTE_INCLUDE });
  let mariamId: string;

  it('release: the employee is told who released it and what they can do; raised: the decider gets the reason; decided: the employee hears kept or changed', async () => {
    await flushMails();
    const mariam = (await cardsOf('2026-10')).get(DEV2)!;
    mariamId = mariam.id;
    // the reviewer's release (the core's endpoint does this; here it is written straight to the table, which the database allows once)
    await prisma.scorecard.update({ where: { id: mariam.id }, data: { status: 'released', releasedAt: t.clock.now(), releasedById: ids[CTO] } });
    await outbox.emit({ type: 'scorecard.released', actor: CTO, payload: releasedPayload(await releasedRow(mariam.id), CTO, true) });

    // a rating the CTO gave is decided by the Director; three disputes: one open, one kept, one changed
    const raise = (taskId: string, reason: string, ratingAtRaise: number) =>
      prisma.ratingDispute.create({ data: { scorecardId: mariam.id, taskId, employeeId: ids[DEV2], reason, ratingAtRaise, deciderId: ids[DIRECTOR] } });
    const open = await raise(fx.t2.id, 'The spec changed after I started.', 4);
    await outbox.emit({ type: 'scorecard.dispute_raised', actor: DEV2, payload: disputeRaisedPayload(await disputeRow(open.id)) });

    const kept = await raise(fx.t3.id, 'I was never told the scope.', 3);
    await prisma.ratingDispute.update({ where: { id: kept.id }, data: { status: 'upheld', decidedById: ids[DIRECTOR], decision: 'The scope was in the brief.', decidedAt: t.clock.now() } });
    await outbox.emit({ type: 'scorecard.dispute_decided', actor: DIRECTOR, payload: disputeDecidedPayload(await disputeRow(kept.id)) });

    const changed = await raise(fx.t4.id, 'It was a small fix.', 4);
    await prisma.ratingDispute.update({ where: { id: changed.id }, data: { status: 'changed', decidedById: ids[DIRECTOR], decision: 'You are right.', newRating: 2, decidedAt: t.clock.now(), scoreBefore: 85, scoreAfter: 82.5 } });
    await outbox.emit({ type: 'scorecard.dispute_decided', actor: DIRECTOR, payload: disputeDecidedPayload(await disputeRow(changed.id)) });

    await dispatcher.tick();
    expect(mailList()).toEqual(
      [
        `${MARIAM} | Your October 2026 scorecard is ready`,
        `${BILAL} | Rating disputed: ${fx.t2.number}`,
        `${MARIAM} | Rating kept: ${fx.t3.number}`,
        `${MARIAM} | Rating changed: ${fx.t4.number}`,
      ].sort(),
    );
    const link = `${env.APP_URL}/performance/scorecards/${mariam.id}`;

    const released = mailsWith('Your October 2026 scorecard is ready', MARIAM)[0];
    expect(released.text).toContain('Hello Mariam Shah,');
    expect(released.text).toContain('Omar Farooq released your scorecard for October 2026.');
    expect(released.text).toContain('dispute the rating of a task');
    expect(released.text).toContain(link);

    const raised = mailsWith(`Rating disputed: ${fx.t2.number}`, BILAL)[0];
    expect(raised.text).toContain('Mariam Shah disputes the rating of');
    expect(raised.text).toContain('rated 4 out of 5');
    expect(raised.text).toContain('Reason: "The spec changed after I started."');
    expect(raised.text).toContain(link);

    const upheld = mailsWith(`Rating kept: ${fx.t3.number}`, MARIAM)[0];
    expect(upheld.text).toContain('Bilal Ahmed looked at your dispute');
    expect(upheld.text).toContain('kept the rating of 3 out of 5');
    expect(upheld.text).toContain('Note: "The scope was in the brief."');

    const alt = mailsWith(`Rating changed: ${fx.t4.number}`, MARIAM)[0];
    expect(alt.text).toContain('changed the rating from 4 to 2 out of 5');
    expect(alt.text).toContain('worked out again with the same weights it was made with');
    expect(alt.text).not.toContain('82.5');

    // delivered once: the dispatcher gives nobody the same event twice
    t.mailer.clear();
    await dispatcher.tick();
    expect(t.mailer.sent).toHaveLength(0);
    expect(await prisma.outboxDelivery.count({ where: { consumer: 'performance.mail' } })).toBeGreaterThanOrEqual(4);
  }, 60000);

  it('a mail server that is down makes the event retry later, and the mail goes out once it is back', async () => {
    await flushMails();
    t.mailer.failing = true;
    await outbox.emit({ type: 'scorecard.released', actor: CTO, payload: releasedPayload(await releasedRow(mariamId), CTO, false) });
    await dispatcher.tick();
    expect(t.mailer.sent).toHaveLength(0);
    const waiting = (await prisma.outboxEvent.findMany({ where: { type: 'scorecard.released', processedAt: null } })).filter((e) => (e.payload as { empId: string }).empId === DEV2);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].lastError).toContain('performance.mail');

    t.mailer.failing = false;
    t.clock.advance(5 * 60_000); // past the retry delay
    await dispatcher.tick();
    expect(mailsWith('Your October 2026 scorecard is ready', MARIAM)).toHaveLength(1);
    expect(await prisma.outboxDelivery.count({ where: { eventId: waiting[0].id, consumer: 'performance.mail' } })).toBe(1);
    await flushMails();
  }, 60000);
});

// ------------------------------------------------------------------------------------------------------------ who gets a scorecard

describe('who gets a scorecard and who reviews it', () => {
  it('a person who joined on the last day of the month is scored, the next day is not; a leaver is not; a leaver\'s report goes to the next reviewer up; nobody joined yet: nobody', async () => {
    const JUL = '2026-07';
    const J1 = await createEmployee(prisma, { name: 'Joined Last Day', officialEmail: 'joined.last.day@acevatech.com' });
    const J2 = await createEmployee(prisma, { name: 'Joined Next Day', officialEmail: 'joined.next.day@acevatech.com' });
    const L = await createEmployee(prisma, { name: 'Left Already', officialEmail: 'left.already@acevatech.com' });
    const NOMAIL = await createEmployee(prisma, { name: 'No Address', officialEmail: null });
    const M = await createEmployee(prisma, { name: 'Test Lead', officialEmail: 'test.lead@acevatech.com', roleKey: 'cto', reportsToEmpId: DIRECTOR });
    const D = await createEmployee(prisma, { name: 'Test Dev', officialEmail: 'test.dev@acevatech.com', roleKey: 'employee', reportsToEmpId: M.empId });
    await prisma.employee.update({ where: { id: J1.id }, data: { joiningDate: new Date('2026-07-31') } }); // the last day of July: before the month ended
    await prisma.employee.update({ where: { id: J2.id }, data: { joiningDate: new Date('2026-08-01') } }); // the first moment after July
    await prisma.employee.update({ where: { id: L.id }, data: { status: 'left' } });
    await prisma.employee.update({ where: { id: M.id }, data: { status: 'left' } }); // the lead of D has left
    await flushMails();

    const result = await monthly.run(JUL, pk('2026-11-17'));
    expect(result).toMatchObject({ created: 14, existing: 0, failed: 0, autoReleased: 1 });
    const cards = await cardsOf(JUL);
    expect([...cards.keys()].sort()).toEqual([...SCORED, J1.empId, NOMAIL.empId, D.empId].sort());
    expect(cards.has(J2.empId)).toBe(false); // joined after the month
    expect(cards.has(L.empId)).toBe(false); // has left
    expect(cards.has(M.empId)).toBe(false); // has left
    expect(cards.has(OWNER)).toBe(false);
    expect(cards.get(J1.empId)!.reviewer?.empId).toBe(CTO);
    // D's manager left: the next one up who reviews work (the Director) reviews D
    expect(cards.get(D.empId)!.reviewer?.empId).toBe(DIRECTOR);
    expect(cards.get(D.empId)!.status).toBe('draft');
    // the mails follow: the CTO's five reports, J1 and the person with no address; the Director's five and D (whose lead left)
    expect(mailList()).toEqual([`${BILAL} | 6 draft scorecards to review: July 2026`, `${OMAR} | 7 draft scorecards to review: July 2026`]);

    // the same month a day later in a re-run: J2 has joined only after July, so still nothing for J2; everybody else is left alone
    expect(await monthly.run(JUL, pk('2026-11-18'))).toMatchObject({ created: 0, existing: 14, failed: 0 });

    // events for people who left, or who have no mail address, are not an error and send nothing
    await flushMails();
    for (const person of [L, NOMAIL]) {
      await outbox.emit({ type: 'scorecard.released', actor: 'system', payload: { scorecardId: randomUUID(), empId: person.empId, month: JUL, kind: 'standard', releasedBy: null, automatic: true, hasRemark: false } });
    }
    await dispatcher.tick();
    expect(t.mailer.sent).toHaveLength(0);
    expect(await prisma.outboxEvent.count({ where: { type: 'scorecard.released', processedAt: null } })).toBe(0);

    // a month before anybody had joined has nobody to score, and is not an error
    t.mailer.clear();
    expect(await monthly.run('2025-12', pk('2026-11-17'))).toEqual({ month: '2025-12', created: 0, existing: 0, autoReleased: 0, failed: 0 });
    expect(t.mailer.sent).toHaveLength(0);
  }, 90000);
});

// ------------------------------------------------------------------------------------------------------------ guards

describe('months the job refuses', () => {
  it('a month that has not started, or that is not a month, is refused; through the job runner the error is kept and the job tries again later', async () => {
    await expect(monthly.run('2099-01')).rejects.toThrow('has not started');
    await expect(monthly.run('2026-13')).rejects.toThrow('is not a month');
    expect(await prisma.scorecard.count({ where: { month: { in: ['2099-01', '2026-13'] } } })).toBe(0);

    await jobs.schedule('scorecard.monthly', 'scorecard.monthly:2099-01', t.clock.now(), { month: '2099-01' }, null);
    await runDueJobs();
    const job = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: 'scorecard.monthly:2099-01' } });
    expect(job).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job.lastError).toContain('has not started');
    expect(job.runAt.getTime()).toBeGreaterThan(t.clock.now().getTime()); // backed off, not retried at once
    await prisma.scheduledJob.delete({ where: { id: job.id } });
  }, 60000);
});
