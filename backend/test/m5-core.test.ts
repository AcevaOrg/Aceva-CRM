import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityRecorder } from '../src/activity/activity-recorder.service';
import { pakistanDay } from '../src/activity/rules/activity-time';
import type { PrismaClient } from '../src/generated/prisma/client';
import { addWorkingDays, nextWorkingDay, pakistanInstant, addDays } from '../src/tasks/rules/task-deadlines';
import { createTestApp, type TestApp } from './helpers/app';
import { createEmployee } from './helpers/people';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 5 core (plan section 9): assigning only down the hierarchy, the status machine with review records, extension
 * requests, manager deadline changes, comments with mentions, files, visibility, workload, the size table and the
 * approvals inbox. Reminders, repeating jobs, mails and the leaver hand-over are in m5-automation.test.ts.
 * Run on its own with: npm test -w backend -- m5-core
 */
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const DEV3 = 'ACV-0008';
const SALES1 = 'ACV-0009';
const FINANCE = 'ACV-0010';
const SQA1 = 'ACV-0011'; // 40 h a week
const SQA2 = 'ACV-0013'; // an intern: 20 h a week (only the overload test gives this person work)

const API = '/api/v1';
const HOUR = 3_600_000;
const DAY = 86_400_000;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const EXE = Buffer.from('MZ\x90\x00this is a program', 'latin1');

interface TaskBody {
  id: string;
  number: string;
  title: string;
  status: string;
  assignee: string;
  assignedBy: string;
  deadline: string;
  originalDeadline: string;
  points: number;
  size: string;
  estimatedHours: number;
  personal: boolean;
  isOverdue: boolean;
  extensionsCount: number;
  reworkCount?: number;
  rating?: number;
  reviewComment?: string;
  checklist: Array<{ id: string; text: string; done: boolean }>;
  attachments: Array<{ id: string; fileName: string }>;
  repeat?: { every: string; on: number; active?: boolean };
}
interface ExtensionBody {
  id: string;
  taskId: string;
  status: string;
  late: boolean;
  currentDeadline: string;
  requestedDeadline: string;
  decidedBy?: string;
  decisionReason?: string;
}
interface HistoryBody {
  kind: string;
  from: string | null;
  to: string;
  by: string;
  reason?: string;
  details?: Record<string, unknown>;
}

let t: TestApp;
let prisma: PrismaClient;
let recorder: ActivityRecorder;

beforeAll(async () => {
  t = await createTestApp();
  prisma = createTestPrisma();
  await t.signInAll();
  recorder = t.app.get(ActivityRecorder);
});
afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase(); // leave a clean, seeded database for the next test file
}, 120000);

// ------------------------------------------------------------------------------------------------ helpers

const at = (offsetMs: number): string => new Date(t.clock.now().getTime() + offsetMs).toISOString();
const inDays = (n: number): string => at(n * DAY);

/** A normal work task for a developer: S size, 1 hour (so nobody becomes overloaded by the tests), a deadline in 10 days. */
const taskBody = (over: Record<string, unknown> = {}) => ({
  title: 'Fix the login bug',
  description: 'Users on mobile cannot log in',
  assignee: DEV2,
  priority: 'medium',
  size: 'S',
  estimatedHours: 1,
  startDate: at(0),
  deadline: inDays(10),
  checklist: [] as string[],
  ...over,
});
const personalBody = (over: Record<string, unknown> = {}) => ({
  title: 'Secret plan for the week',
  description: '',
  priority: 'low',
  size: 'XS',
  estimatedHours: 1,
  startDate: at(0),
  deadline: inDays(3),
  checklist: [] as string[],
  personal: true,
  ...over,
});

const create = async (who: string, over: Record<string, unknown> = {}): Promise<TaskBody> => (await t.as(who).post(`${API}/tasks`).send(taskBody(over)).expect(201)).body;
const act = (who: string, id: string, action: string, body: Record<string, unknown> = {}) => t.as(who).post(`${API}/tasks/${id}/${action}`).send(body);
const detail = async (who: string, id: string) => (await t.as(who).get(`${API}/tasks/${id}`).expect(200)).body as { task: TaskBody; comments: Array<{ author: string; mentions: string[]; attachments: Array<{ id: string; fileName: string }> }>; extensions: ExtensionBody[]; history: HistoryBody[]; reviewer: string | null; actingAssigner: string | null };
const statusOf = async (id: string): Promise<string> => (await prisma.task.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

/** A task that is already submitted and waiting for its reviewer. */
async function submitted(assigner: string, assignee = DEV2, over: Record<string, unknown> = {}): Promise<TaskBody> {
  const task = await create(assigner, { assignee, ...over });
  await act(assignee, task.id, 'start').expect(200);
  await act(assignee, task.id, 'submit').expect(200);
  return task;
}

async function eventsOf(type: string, number: string) {
  const rows = await prisma.outboxEvent.findMany({ where: { type }, orderBy: { occurredAt: 'asc' } });
  return rows.filter((r) => (r.payload as { number?: string }).number === number);
}
const auditOf = (action: string, number: string) => prisma.auditLog.findMany({ where: { action, targetId: number }, include: { actor: true }, orderBy: { occurredAt: 'asc' } });

let seeded = 8000;
/** A task written straight into the database, for the cases that need a deadline that has already passed. */
async function seedTask(over: { assignee?: string; assignedBy?: string; status?: 'assigned' | 'in_progress' | 'submitted'; deadline?: Date } = {}) {
  const assignee = await prisma.employee.findUniqueOrThrow({ where: { empId: over.assignee ?? DEV3 }, select: { id: true } });
  const by = await prisma.employee.findUniqueOrThrow({ where: { empId: over.assignedBy ?? CTO }, select: { id: true } });
  const deadline = over.deadline ?? new Date(Date.now() - DAY);
  return prisma.task.create({
    data: {
      number: `TSK-${++seeded}`,
      title: 'An old task',
      assigneeId: assignee.id,
      assignedById: by.id,
      size: 'S',
      points: 2,
      estimatedHours: 1,
      startDate: new Date(Date.now() - 5 * DAY),
      deadline,
      originalDeadline: deadline,
      status: over.status ?? 'in_progress',
    },
  });
}

const download = (who: string, taskId: string, attachmentId: string) =>
  t
    .as(who)
    .get(`${API}/tasks/${taskId}/attachments/${attachmentId}/download`)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (d) => chunks.push(d));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

// ------------------------------------------------------------------------------------------------ assigning

describe('M5 assigning: only down the hierarchy, only by people who hold task.assign', () => {
  let first: TaskBody;

  it('the CTO assigns a task to a developer: a numbered task, points from the size table, history, audit entry and event', async () => {
    first = await create(CTO, { checklist: ['Reproduce it', 'Fix it'] });
    expect(first).toMatchObject({ status: 'assigned', assignee: DEV2, assignedBy: CTO, size: 'S', points: 2, estimatedHours: 1, personal: false, isOverdue: false, extensionsCount: 0 });
    expect(first.number).toMatch(/^TSK-\d{4,}$/);
    expect(first.originalDeadline).toBe(first.deadline);
    expect(first.checklist.map((c) => c.text)).toEqual(['Reproduce it', 'Fix it']);

    const d = await detail(CTO, first.id);
    expect(d.history).toHaveLength(1);
    expect(d.history[0]).toMatchObject({ kind: 'created', from: null, to: 'assigned', by: CTO });
    expect(d.reviewer).toBe(CTO); // the assigner reviews

    const audit = await auditOf('task.created', first.number);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor?.empId).toBe(CTO);
    const events = await eventsOf('task.created', first.number);
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe(CTO);
    expect(events[0].payload).toMatchObject({ assignee: DEV2, assignedBy: CTO, personal: false, size: 'S', points: 2, repeatRuleId: null });
  });

  it('the Director assigns to anyone below him: the CTO, Sales, Finance and a developer', async () => {
    for (const who of [CTO, SALES1, FINANCE, DEV1]) {
      const task = await create(DIRECTOR, { assignee: who });
      expect(task).toMatchObject({ assignee: who, assignedBy: DIRECTOR });
    }
  });

  it('assigning upward, sideways, to yourself, or by someone without task.assign is refused (403) and creates nothing', async () => {
    const before = await prisma.task.count();
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ assignee: DIRECTOR })).expect(403); // up
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ assignee: SALES1 })).expect(403); // beside: not in the CTO's line
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ assignee: CTO })).expect(403); // yourself
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ assignee: OWNER })).expect(403);
    await t.as(DIRECTOR).post(`${API}/tasks`).send(taskBody({ assignee: DIRECTOR })).expect(403);
    await t.as(DIRECTOR).post(`${API}/tasks`).send(taskBody({ assignee: OWNER })).expect(403);
    await t.as(DEV1).post(`${API}/tasks`).send(taskBody({ assignee: DEV2 })).expect(403); // a peer, and no task.assign
    await t.as(FINANCE).post(`${API}/tasks`).send(taskBody({ assignee: DEV2 })).expect(403);
    await t.as(OWNER).post(`${API}/tasks`).send(taskBody({ assignee: DEV1 })).expect(403); // the Owner is view-only
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ assignee: 'ACV-0999' })).expect(404);
    expect(await prisma.task.count()).toBe(before);
  });

  it('refuses XL (it must be split), a deadline in the past and a missing owner', async () => {
    const xl = await t.as(CTO).post(`${API}/tasks`).send(taskBody({ size: 'XL' })).expect(400);
    expect(xl.body.code).toBe('size_xl_not_assignable');
    const past = await t.as(CTO).post(`${API}/tasks`).send(taskBody({ startDate: at(-3 * DAY), deadline: at(-DAY) })).expect(400);
    expect(past.body.code).toBe('deadline_in_past');
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ deadline: at(-HOUR * 5), startDate: at(0) })).expect(400); // before the start
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ assignee: undefined })).expect(400);
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ projectId: '11111111-1111-4111-8111-111111111111' })).expect(400); // no such project
  });

  it('refuses a far-off deadline at once: outside the years 2020 to 2100, or more than two years after the start', async () => {
    const started = Date.now();
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ deadline: '9999-12-31T00:00:00.000Z' })).expect(400);
    expect((await t.as(CTO).post(`${API}/tasks`).send(taskBody({ deadline: inDays(1100) })).expect(400)).body.code).toBe('deadline_too_far');
    const task = await create(CTO, { assignee: DEV2 });
    await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ deadline: '9999-12-31T00:00:00.000Z', reason: 'The client moved the date' }).expect(400);
    expect((await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ deadline: inDays(1100), reason: 'The client moved the date' }).expect(400)).body.code).toBe('deadline_too_far');
    await t.as(DEV2).post(`${API}/tasks/${task.id}/extensions`).send({ requestedDeadline: '9999-12-31T00:00:00.000Z', reason: 'I need a lot more time' }).expect(400);
    expect(Date.now() - started).toBeLessThan(10_000); // it used to run for ever
  });

  it('warns about a too-short deadline: nothing is created until the person confirms', async () => {
    const before = await prisma.task.count();
    const res = await t.as(CTO).post(`${API}/tasks`).send(taskBody({ size: 'M', deadline: at(HOUR) })).expect(409);
    expect(res.body).toMatchObject({ statusCode: 409, code: 'confirmation_required' });
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatchObject({ code: 'deadline_too_short', details: { size: 'M', neededDays: 3 } });
    expect(res.body.warnings[0].message).toContain('An M task usually needs 3 working days');
    expect(await prisma.task.count()).toBe(before);

    const confirmed = await t.as(CTO).post(`${API}/tasks`).send(taskBody({ size: 'M', deadline: at(HOUR), confirmWarnings: true })).expect(201);
    expect(confirmed.body).toMatchObject({ size: 'M', points: 3 });
    expect(await prisma.task.count()).toBe(before + 1);
  });

  it('counts working days only and skips holidays: a holiday inside the window makes the same deadline too short', async () => {
    // A start on a working day in the future, a deadline 18:00 on the third working day after it.
    const known = new Set((await prisma.holiday.findMany()).map((h) => h.date.toISOString().slice(0, 10)));
    const startDay = nextWorkingDay(addDays(pakistanDay(t.clock.now()), 1), known);
    const start = pakistanInstant(startDay, '09:00');
    const deadline = pakistanInstant(addWorkingDays(startDay, 3, known), '18:00');
    const body = taskBody({ assignee: DEV3, size: 'M', startDate: start.toISOString(), deadline: deadline.toISOString() });
    await t.as(CTO).post(`${API}/tasks`).send(body).expect(201); // 3 working days given: no warning

    const holiday = addWorkingDays(startDay, 1, known);
    await prisma.holiday.create({ data: { date: new Date(`${holiday}T00:00:00.000Z`), name: 'Test holiday' } });
    try {
      const res = await t.as(CTO).post(`${API}/tasks`).send(body).expect(409);
      expect(res.body.warnings[0]).toMatchObject({ code: 'deadline_too_short', details: { neededDays: 3, givenDays: 2 } });
    } finally {
      await prisma.holiday.deleteMany({ where: { name: 'Test holiday' } });
    }
  });

  it('warns when the assignee would go over their weekly capacity (an intern has 20 h) and creates the task once confirmed', async () => {
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ assignee: SQA2, size: 'L', estimatedHours: 16, deadline: inDays(30) })).expect(201);
    const res = await t.as(CTO).post(`${API}/tasks`).send(taskBody({ assignee: SQA2, size: 'S', estimatedHours: 8 })).expect(409);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.warnings[0]).toMatchObject({ code: 'overloaded', details: { empId: SQA2, openHours: 16, addedHours: 8, capacity: 20 } });
    expect(res.body.warnings[0].message).toContain('24 h of 20 h');
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ assignee: SQA2, size: 'S', estimatedHours: 8, confirmWarnings: true })).expect(201);
  });

  it('shows the team workload (open hours against weekly capacity) to managers only', async () => {
    const rows: Array<{ empId: string; openHours: number; capacity: number; openTasks: number }> = (await t.as(CTO).get(`${API}/tasks/workload`).expect(200)).body;
    expect(rows.map((r) => r.empId)).toEqual([...rows.map((r) => r.empId)].sort());
    expect(rows.map((r) => r.empId)).toEqual(expect.arrayContaining([DEV1, DEV2, DEV3, SQA1, SQA2]));
    expect(rows.map((r) => r.empId)).not.toContain(CTO); // people below only
    expect(rows.map((r) => r.empId)).not.toContain(SALES1);
    expect(rows.find((r) => r.empId === SQA2)).toEqual({ empId: SQA2, openHours: 24, capacity: 20, openTasks: 2 });
    expect(rows.find((r) => r.empId === SQA1)).toEqual({ empId: SQA1, openHours: 0, capacity: 40, openTasks: 0 }); // nobody is left out

    const wide: Array<{ empId: string }> = (await t.as(DIRECTOR).get(`${API}/tasks/workload`).expect(200)).body;
    expect(wide.map((r) => r.empId)).toEqual(expect.arrayContaining([CTO, SALES1, FINANCE, DEV1]));
    await t.as(DEV1).get(`${API}/tasks/workload`).expect(403);
  });

  it('keeps a size table copy: a task keeps the points and hours it was created with', async () => {
    const task = await prisma.task.findUniqueOrThrow({ where: { id: first.id } });
    expect(task.points).toBe(2);
    expect(Number(task.estimatedHours)).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ personal to-dos

describe('M5 personal to-dos: private, never scored', () => {
  it('anyone adds one for themselves; managers and the Owner cannot see it', async () => {
    const res = await t.as(DEV1).post(`${API}/tasks`).send(personalBody()).expect(201);
    const todo: TaskBody = res.body;
    expect(todo).toMatchObject({ personal: true, assignee: DEV1, assignedBy: DEV1, points: 0, status: 'assigned' });
    expect(todo.number).toMatch(/^TODO-\d{4,}$/);

    for (const who of [CTO, DIRECTOR, OWNER, DEV2]) await t.as(who).get(`${API}/tasks/${todo.id}`).expect(404);
    for (const who of [CTO, DIRECTOR, OWNER]) {
      const all: TaskBody[] = (await t.as(who).get(`${API}/tasks?scope=all&includePersonal=true`).expect(200)).body;
      expect(all.some((x) => x.id === todo.id)).toBe(false);
    }
    const team: TaskBody[] = (await t.as(CTO).get(`${API}/tasks?scope=team&assignee=${DEV1}&includePersonal=true`).expect(200)).body;
    expect(team.some((x) => x.personal)).toBe(false);
    const open = await prisma.task.count({ where: { assignee: { empId: DEV1 }, personal: false, status: { notIn: ['approved', 'cancelled'] } } });
    expect((await t.as(CTO).get(`${API}/tasks/workload`).expect(200)).body.find((r: { empId: string }) => r.empId === DEV1).openTasks).toBe(open); // the to-do is not counted

    const mine: TaskBody[] = (await t.as(DEV1).get(`${API}/tasks?scope=mine`).expect(200)).body;
    expect(mine.some((x) => x.id === todo.id)).toBe(false); // only with includePersonal
    const withPersonal: TaskBody[] = (await t.as(DEV1).get(`${API}/tasks?scope=mine&includePersonal=true`).expect(200)).body;
    expect(withPersonal.some((x) => x.id === todo.id)).toBe(true);

    // private: no audit entry, no event, and its history is its owner's alone
    expect(await prisma.auditLog.count({ where: { targetId: todo.number } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { payload: { path: ['number'], equals: todo.number } } })).toBe(0);
  });

  it('is done and reopened by its owner without a review or a rating, and is never scored', async () => {
    const todo: TaskBody = (await t.as(DEV1).post(`${API}/tasks`).send(personalBody({ size: 'XL' })).expect(201)).body; // any size is fine for a to-do
    await act(DEV1, todo.id, 'start').expect(200);
    const done: TaskBody = (await act(DEV1, todo.id, 'done').expect(200)).body;
    expect(done.status).toBe('approved');
    expect(done.rating).toBeUndefined();
    expect(await prisma.taskReview.count({ where: { taskId: todo.id } })).toBe(0);
    expect((await act(DEV1, todo.id, 'reopen').expect(200)).body.status).toBe('assigned');
    expect((await act(DEV1, todo.id, 'cancel', { reason: 'No longer needed' }).expect(200)).body.status).toBe('cancelled');
    await act(DEV1, todo.id, 'submit').expect(409); // there is nothing to submit or review
  });

  it('is edited and ticked by its owner only; it cannot be given to someone else', async () => {
    const todo: TaskBody = (await t.as(DEV1).post(`${API}/tasks`).send(personalBody({ checklist: ['One'] })).expect(201)).body;
    const edited = await t.as(DEV1).patch(`${API}/tasks/${todo.id}`).send({ title: 'A better title', priority: 'high' }).expect(200);
    expect(edited.body).toMatchObject({ title: 'A better title', priority: 'high' });
    await t.as(DEV1).patch(`${API}/tasks/${todo.id}`).send({ assignee: DEV2 }).expect(400);
    const ticked = await t.as(DEV1).patch(`${API}/tasks/${todo.id}/checklist/${todo.checklist[0].id}`).expect(200);
    expect(ticked.body).toMatchObject({ text: 'One', done: true });
    await t.as(CTO).patch(`${API}/tasks/${todo.id}/checklist/${todo.checklist[0].id}`).expect(404);
    await t.as(DEV1).post(`${API}/tasks`).send(personalBody({ assignee: DEV2 })).expect(400);
    await t.as(DEV1).post(`${API}/tasks`).send(personalBody({ repeat: { every: 'week', on: 1 } })).expect(400);
    const history = (await detail(DEV1, todo.id)).history;
    expect(history.map((h) => h.kind)).toEqual(['created', 'edited']);
  });

  it('is named in the activity timeline without its title', async () => {
    await recorder.flush();
    const rows = await prisma.activityEvent.findMany({ where: { employee: { empId: DEV1 }, module: 'Tasks' } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.description.includes('Secret plan'))).toBe(false);
    expect(rows.some((r) => r.description === 'Added a personal to-do')).toBe(true);
    // ...and without its id or number either: every record about a personal to-do has no target
    const personalRows = rows.filter((r) => r.description.includes('personal to-do'));
    expect(personalRows.length).toBeGreaterThan(3); // added, done, reopened, cancelled, edited, ticked
    expect(personalRows.every((r) => r.target === null)).toBe(true);
    const todos = await prisma.task.findMany({ where: { personal: true }, select: { id: true, number: true } });
    expect(todos.length).toBeGreaterThan(0);
    expect(await prisma.activityEvent.count({ where: { target: { in: todos.flatMap((x) => [x.id, x.number]) } } })).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ visibility and lists

describe('M5 who sees which tasks', () => {
  let task: TaskBody;
  it('a work task is seen by the assignee, the assigner, everyone above the assignee and the Owner (read only), nobody else (404)', async () => {
    task = await create(CTO, { assignee: DEV1 });
    for (const who of [DEV1, CTO, DIRECTOR, OWNER]) expect((await detail(who, task.id)).task.id).toBe(task.id);
    for (const who of [DEV2, SQA1, SALES1, FINANCE]) await t.as(who).get(`${API}/tasks/${task.id}`).expect(404);
    expect((await detail(CTO, task.number)).task.id).toBe(task.id); // the number works too
    await t.as(DEV2).get(`${API}/tasks/${task.id}/comments`).expect(404);
    await t.as(DEV2).get(`${API}/tasks/not-a-task`).expect(404);
    await t.as(DEV2).post(`${API}/tasks/${task.id}/start`).send({}).expect(404);
  });

  it('the Director sees the tasks of people below him; a peer of the assignee sees none of them', async () => {
    const director: TaskBody[] = (await t.as(DIRECTOR).get(`${API}/tasks?scope=team`).expect(200)).body;
    expect(director.some((x) => x.id === task.id)).toBe(true);
    const peer: TaskBody[] = (await t.as(DEV2).get(`${API}/tasks?scope=all`).expect(200)).body;
    expect(peer.some((x) => x.id === task.id)).toBe(false);
    await t.as(DEV2).get(`${API}/tasks?scope=team`).expect(403);
  });

  it('lists My Tasks sorted by deadline and filters by status, priority, size, project, assignee and due range', async () => {
    const projects: Array<{ id: string; name: string }> = (await t.as(DEV1).get(`${API}/projects`).expect(200)).body;
    expect(projects.length).toBeGreaterThanOrEqual(5);
    expect(projects[0].id).toMatch(/^[0-9a-f-]{36}$/);
    const early = await create(CTO, { assignee: DEV3, priority: 'high', size: 'M', projectId: projects[0].id, deadline: inDays(8) });
    const late = await create(CTO, { assignee: DEV3, priority: 'low', deadline: inDays(40) });

    const mine: TaskBody[] = (await t.as(DEV3).get(`${API}/tasks?scope=mine`).expect(200)).body;
    const times = mine.map((x) => new Date(x.deadline).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(mine.every((x) => x.assignee === DEV3 && !x.personal)).toBe(true);

    const ids = async (query: string, who = CTO) => ((await t.as(who).get(`${API}/tasks?${query}`).expect(200)).body as TaskBody[]).map((x) => x.id);
    expect(await ids(`scope=team&assignee=${DEV3}&priority=high`)).toEqual([early.id]);
    expect(await ids(`scope=team&assignee=${DEV3}&size=M&priority=high`)).toEqual([early.id]);
    expect(await ids(`scope=team&assignee=${DEV3}&projectId=${projects[0].id}`)).toEqual([early.id]);
    expect(await ids(`scope=team&assignee=${DEV3}&status=assigned&priority=low`)).toEqual([late.id]);
    expect(await ids(`scope=team&assignee=${DEV3}&status=approved`)).toEqual([]);
    const lateDay = pakistanDay(new Date(late.deadline));
    expect(await ids(`scope=team&assignee=${DEV3}&dueFrom=${lateDay}&dueTo=${lateDay}`)).toEqual([late.id]);
    const earlyDay = pakistanDay(new Date(early.deadline));
    expect(await ids(`scope=team&assignee=${DEV3}&dueFrom=${earlyDay}&dueTo=${earlyDay}`)).toEqual([early.id]);
    await t.as(CTO).get(`${API}/tasks?scope=nonsense`).expect(400);
  });

  it('leaves out tasks closed more than 90 days ago unless closed=all asks for them; open=true leaves out every closed task', async () => {
    const closedAgo = async (days: number) => {
      const old = await seedTask({ assignee: DEV3, status: 'in_progress' });
      return prisma.task.update({ where: { id: old.id }, data: { status: 'approved', closedAt: new Date(Date.now() - days * DAY) } });
    };
    const longAgo = await closedAgo(120);
    const lately = await closedAgo(5);
    const stillOpen = await seedTask({ assignee: DEV3, status: 'in_progress' });
    const idsOf = async (query: string) => ((await t.as(DEV3).get(`${API}/tasks?scope=mine${query}`).expect(200)).body as TaskBody[]).map((x) => x.id);

    const normal = await idsOf('');
    expect(normal).toEqual(expect.arrayContaining([lately.id, stillOpen.id]));
    expect(normal).not.toContain(longAgo.id);
    expect(await idsOf('&closed=all')).toEqual(expect.arrayContaining([longAgo.id, lately.id, stillOpen.id]));
    const onlyOpen = await idsOf('&open=true');
    expect(onlyOpen).toContain(stillOpen.id);
    expect(onlyOpen).not.toContain(lately.id);
    expect(onlyOpen).not.toContain(longAgo.id);
    await t.as(DEV3).get(`${API}/tasks?scope=mine&closed=never`).expect(400);
  });

  it('flags an open task past its deadline as overdue, but not one that is waiting for its reviewer', async () => {
    const overdue = await seedTask({ status: 'in_progress' });
    const waiting = await seedTask({ status: 'submitted' });
    expect((await detail(DEV3, overdue.id)).task.isOverdue).toBe(true);
    expect((await detail(DEV3, waiting.id)).task.isOverdue).toBe(false);
    expect((await detail(DEV3, overdue.id)).task.status).toBe('in_progress'); // a flag on top of the status, never a status
  });
});

// ------------------------------------------------------------------------------------------------ status machine

describe('M5 the status machine, reviews and who may do each step', () => {
  it('assigned -> in progress -> submitted -> under review -> approved with a rating, with a review record and full history', async () => {
    const task = await create(CTO, { assignee: DEV2 });
    expect((await act(DEV2, task.id, 'start').expect(200)).body.status).toBe('in_progress');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).startedAt).not.toBeNull();
    const sub: TaskBody = (await act(DEV2, task.id, 'submit').expect(200)).body;
    expect(sub.status).toBe('submitted');
    expect((await detail(DEV2, task.id)).reviewer).toBe(CTO);
    expect((await act(CTO, task.id, 'review').expect(200)).body.status).toBe('under_review');
    const done: TaskBody = (await act(CTO, task.id, 'approve', { rating: 5, comment: 'Clean work' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'approved', rating: 5, reviewComment: 'Clean work' });

    const reviews = await prisma.taskReview.findMany({ where: { taskId: task.id }, include: { reviewer: true } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ decision: 'approved', rating: 5, comment: 'Clean work', reason: null });
    expect(reviews[0].reviewer.empId).toBe(CTO);
    expect(reviews[0].submittedAt).not.toBeNull();

    const history = (await detail(CTO, task.id)).history;
    expect(history.map((h) => [h.kind, h.from, h.to, h.by])).toEqual([
      ['created', null, 'assigned', CTO],
      ['status', 'assigned', 'in_progress', DEV2],
      ['status', 'in_progress', 'submitted', DEV2],
      ['status', 'submitted', 'under_review', CTO],
      ['status', 'under_review', 'approved', CTO],
    ]);
    expect(history[4].details).toMatchObject({ rating: 5 });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).closedAt).not.toBeNull();

    expect(await eventsOf('task.status_changed', task.number)).toHaveLength(4);
    const approved = await eventsOf('task.approved', task.number);
    expect(approved).toHaveLength(1);
    expect(approved[0].actor).toBe(CTO);
    expect(approved[0].payload).toMatchObject({ assignee: DEV2, reviewer: CTO, rating: 5, size: 'S', points: 2, onTime: true, extensionsCount: 0, reworkCount: 0 });
    expect(await auditOf('task.approve', task.number)).toHaveLength(1);
  });

  it('nobody reviews their own task, and only the reviewer reviews: the Director above the CTO, a peer and the Owner are refused', async () => {
    const task = await submitted(CTO, DEV2);
    const answer = await act(DEV2, task.id, 'approve', { rating: 5 }).expect(403);
    expect(answer.body.code).toBe('not_allowed');
    await act(DEV2, task.id, 'rework', { reason: 'I want to redo it' }).expect(403);
    await act(DEV2, task.id, 'review').expect(403);
    await act(DIRECTOR, task.id, 'approve', { rating: 5 }).expect(403); // sees it, but the assigner reviews
    await act(OWNER, task.id, 'approve', { rating: 5 }).expect(403); // view only
    await act(DEV1, task.id, 'approve', { rating: 5 }).expect(404); // cannot even see it
    expect(await statusOf(task.id)).toBe('submitted');
    expect(await prisma.taskReview.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('only the person doing the task starts and submits it; others are refused', async () => {
    const task = await create(CTO, { assignee: DEV2 });
    await act(CTO, task.id, 'start').expect(403);
    await act(DIRECTOR, task.id, 'start').expect(403);
    await act(DEV2, task.id, 'start').expect(200);
    await act(CTO, task.id, 'submit').expect(403);
    await act(DEV2, task.id, 'submit').expect(200);
  });

  it('an approval needs a rating from 1 to 5; a rework needs a reason', async () => {
    const task = await submitted(CTO, DEV2);
    await act(CTO, task.id, 'approve', {}).expect(400);
    await act(CTO, task.id, 'approve', { rating: 6 }).expect(400);
    await act(CTO, task.id, 'approve', { rating: 0 }).expect(400);
    await act(CTO, task.id, 'rework', {}).expect(400);
    await act(CTO, task.id, 'rework', { reason: 'no' }).expect(400);
    expect(await statusOf(task.id)).toBe('submitted');
  });

  it('sends a task back to rework with a reason, counts it, and lets the person submit again', async () => {
    const task = await submitted(CTO, DEV2);
    const back: TaskBody = (await act(CTO, task.id, 'rework', { reason: 'The error message is wrong' }).expect(200)).body;
    expect(back).toMatchObject({ status: 'rework', reworkCount: 1, reviewComment: 'The error message is wrong' });
    const review = await prisma.taskReview.findFirstOrThrow({ where: { taskId: task.id } });
    expect(review).toMatchObject({ decision: 'rework', rating: null, reason: 'The error message is wrong' });
    const reworked = await eventsOf('task.reworked', task.number);
    expect(reworked).toHaveLength(1);
    expect(reworked[0].payload).toMatchObject({ assignee: DEV2, reviewer: CTO, reason: 'The error message is wrong', reworkCount: 1 });

    await act(DEV2, task.id, 'submit').expect(200); // straight from rework
    const done: TaskBody = (await act(CTO, task.id, 'approve', { rating: 4 }).expect(200)).body;
    expect(done).toMatchObject({ status: 'approved', rating: 4, reworkCount: 1 });
    expect((await eventsOf('task.approved', task.number))[0].payload).toMatchObject({ reworkCount: 1, rating: 4 });
    expect(await prisma.taskReview.count({ where: { taskId: task.id } })).toBe(2);
  });

  it('answers 409 when the status makes an action impossible for anybody', async () => {
    const task = await create(CTO, { assignee: DEV2 });
    expect((await act(CTO, task.id, 'approve', { rating: 5 }).expect(409)).body.code).toBe('invalid_state'); // nothing was submitted
    await act(DEV2, task.id, 'submit').expect(409); // not started
    await act(DEV2, task.id, 'start').expect(200);
    await act(DEV2, task.id, 'start').expect(409); // already started
    await act(DEV2, task.id, 'done').expect(409); // "done" is only for personal to-dos
    await act(CTO, task.id, 'resume').expect(409); // not on hold
  });

  it('puts a task on hold, resumes it, and cancels it: the assigner only, with a reason; closed tasks stay closed', async () => {
    const task = await create(CTO, { assignee: DEV2 });
    await act(DEV2, task.id, 'start').expect(200);
    await act(CTO, task.id, 'hold', {}).expect(400);
    await act(DEV2, task.id, 'hold', { reason: 'I am too busy' }).expect(403);
    await act(DIRECTOR, task.id, 'hold', { reason: 'Not mine to hold' }).expect(403);
    expect((await act(CTO, task.id, 'hold', { reason: 'Waiting for the client' }).expect(200)).body.status).toBe('on_hold');
    await act(DEV2, task.id, 'submit').expect(409); // on hold
    await act(CTO, task.id, 'hold', { reason: 'Again' }).expect(409);
    await act(DEV2, task.id, 'resume').expect(403);
    expect((await act(CTO, task.id, 'resume').expect(200)).body.status).toBe('in_progress');
    await act(DEV2, task.id, 'cancel', { reason: 'I do not want it' }).expect(403);
    await act(CTO, task.id, 'cancel', {}).expect(400);
    const cancelled: TaskBody = (await act(CTO, task.id, 'cancel', { reason: 'The client dropped it' }).expect(200)).body;
    expect(cancelled.status).toBe('cancelled');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).closedAt).not.toBeNull();
    await act(DEV2, task.id, 'submit').expect(409);
    await act(CTO, task.id, 'resume').expect(409);
    const history = (await detail(CTO, task.id)).history;
    expect(history.slice(-3).map((h) => [h.to, h.reason ?? null])).toEqual([['on_hold', 'Waiting for the client'], ['in_progress', null], ['cancelled', 'The client dropped it']]);
  });

  it('a task on hold can also be cancelled by the assigner', async () => {
    const task = await create(CTO, { assignee: DEV2 });
    await act(CTO, task.id, 'hold', { reason: 'Parked for now' }).expect(200);
    expect((await act(CTO, task.id, 'cancel', { reason: 'No longer needed' }).expect(200)).body.status).toBe('cancelled');
  });

  it('two reviewers clicking at the same moment: one decision, one 409, one review record', async () => {
    const task = await submitted(CTO, DEV2);
    const results = await Promise.all([act(CTO, task.id, 'approve', { rating: 5 }), act(CTO, task.id, 'approve', { rating: 3 })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.taskReview.count({ where: { taskId: task.id } })).toBe(1);
    expect(await eventsOf('task.approved', task.number)).toHaveLength(1);
  });

  it('records the action once for the activity timeline, naming the task (the recorder is reused)', async () => {
    const task = await create(CTO, { assignee: DEV3 });
    await act(DEV3, task.id, 'start').expect(200);
    await recorder.flush();
    const rows = await prisma.activityEvent.findMany({ where: { employee: { empId: DEV3 }, module: 'Tasks', target: task.number } });
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe(`Started task ${task.number}`);
  });

  it('the Director assigning to a developer reviews it himself (not the CTO); a task given to the CTO is reviewed by the Director, never by the CTO', async () => {
    const forDev = await submitted(DIRECTOR, DEV1);
    expect((await detail(DEV1, forDev.id)).reviewer).toBe(DIRECTOR);
    await act(CTO, forDev.id, 'approve', { rating: 5 }).expect(403); // the CTO manages the developer, but the Director assigned it
    expect((await act(DIRECTOR, forDev.id, 'approve', { rating: 5 }).expect(200)).body.status).toBe('approved');

    const forCto = await submitted(DIRECTOR, CTO);
    expect((await detail(CTO, forCto.id)).reviewer).toBe(DIRECTOR);
    await act(CTO, forCto.id, 'approve', { rating: 5 }).expect(403);
    expect((await act(DIRECTOR, forCto.id, 'approve', { rating: 4 }).expect(200)).body.status).toBe('approved');
  });
});

// ------------------------------------------------------------------------------------------------ extensions

describe('M5 extension requests', () => {
  let task: TaskBody;
  let rejected: ExtensionBody;
  let approved: ExtensionBody;
  const newDeadline = () => new Date(new Date(task.deadline).getTime() + 3 * DAY).toISOString();

  it('the person doing the task asks for more time before the deadline: a pending request, on time, with history, audit and event', async () => {
    task = await create(CTO, { assignee: DEV2, deadline: inDays(10) });
    await act(DEV2, task.id, 'start').expect(200);
    const res = await t.as(DEV2).post(`${API}/tasks/${task.id}/extensions`).send({ requestedDeadline: newDeadline(), reason: 'Waiting for the API keys' }).expect(201);
    rejected = res.body;
    expect(rejected).toMatchObject({ status: 'pending', late: false, currentDeadline: task.deadline, requestedDeadline: newDeadline() });
    const d = await detail(DEV2, task.id);
    expect(d.extensions).toHaveLength(1);
    expect(d.history.at(-1)).toMatchObject({ kind: 'extension_requested', by: DEV2, reason: 'Waiting for the API keys' });
    expect(await auditOf('task.extension.requested', task.number)).toHaveLength(1);
    const events = await eventsOf('task.extension_requested', task.number);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ extensionId: rejected.id, late: false, assignee: DEV2, assignedBy: CTO });
  });

  it('only one request waits at a time, it must be later than the deadline, and only the person doing the task asks', async () => {
    const again = await t.as(DEV2).post(`${API}/tasks/${task.id}/extensions`).send({ requestedDeadline: inDays(30), reason: 'One more try' }).expect(409);
    expect(again.body.code).toBe('extension_pending');
    await t.as(CTO).post(`${API}/tasks/${task.id}/extensions`).send({ requestedDeadline: inDays(30), reason: 'I decide this myself' }).expect(403);
    await t.as(DEV1).post(`${API}/tasks/${task.id}/extensions`).send({ requestedDeadline: inDays(30), reason: 'Not mine at all' }).expect(404);
    const other = await create(CTO, { assignee: DEV2, deadline: inDays(10) });
    const notLater = await t.as(DEV2).post(`${API}/tasks/${other.id}/extensions`).send({ requestedDeadline: other.deadline, reason: 'Same date' }).expect(400);
    expect(notLater.body.code).toBe('extension_not_later');
    await t.as(DEV2).post(`${API}/tasks/${other.id}/extensions`).send({ requestedDeadline: inDays(20), reason: 'ok' }).expect(400); // reason too short
  });

  it('nobody decides their own request, and only the assigner (or whoever stands in) decides: the Director above the CTO, a peer and the Owner cannot', async () => {
    await t.as(DEV2).post(`${API}/extensions/${rejected.id}/approve`).send({}).expect(403);
    await t.as(DIRECTOR).post(`${API}/extensions/${rejected.id}/approve`).send({}).expect(403);
    await t.as(OWNER).post(`${API}/extensions/${rejected.id}/approve`).send({}).expect(403);
    await t.as(DEV1).post(`${API}/extensions/${rejected.id}/approve`).send({}).expect(404);
    await t.as(DEV2).post(`${API}/extensions/not-an-id/approve`).send({}).expect(400);
    expect((await prisma.taskExtension.findUniqueOrThrow({ where: { id: rejected.id } })).status).toBe('pending');
  });

  it('a rejection needs a reason; the deadline stays and the count does not move', async () => {
    await t.as(CTO).post(`${API}/extensions/${rejected.id}/reject`).send({}).expect(400);
    const res = await t.as(CTO).post(`${API}/extensions/${rejected.id}/reject`).send({ reason: 'The deadline is fixed by the client' }).expect(200);
    expect(res.body).toMatchObject({ status: 'rejected', decidedBy: CTO, decisionReason: 'The deadline is fixed by the client' });
    const fresh = (await detail(DEV2, task.id)).task;
    expect(fresh).toMatchObject({ deadline: task.deadline, extensionsCount: 0 });
    expect(await eventsOf('task.deadline_changed', task.number)).toHaveLength(0);
    expect((await eventsOf('task.extension_decided', task.number))[0].payload).toMatchObject({ decision: 'rejected', newDeadline: null, decidedBy: CTO, requestedBy: DEV2 });
    await t.as(CTO).post(`${API}/extensions/${rejected.id}/approve`).send({}).expect(409); // already answered
  });

  it('an approval saves the new deadline and keeps the original; the extension is counted and on-time is measured against the new deadline', async () => {
    approved = (await t.as(DEV2).post(`${API}/tasks/${task.id}/extensions`).send({ requestedDeadline: newDeadline(), reason: 'Second try, with a plan' }).expect(201)).body;
    const res = await t.as(CTO).post(`${API}/extensions/${approved.id}/approve`).send({}).expect(200);
    expect(res.body).toMatchObject({ status: 'approved', decidedBy: CTO });
    const fresh = (await detail(DEV2, task.id)).task;
    expect(fresh).toMatchObject({ deadline: newDeadline(), originalDeadline: task.deadline, extensionsCount: 1 });
    const moved = await eventsOf('task.deadline_changed', task.number);
    expect(moved).toHaveLength(1);
    expect(moved[0].payload).toMatchObject({ kind: 'extension_approved', from: task.deadline, to: newDeadline() });
    expect((await detail(CTO, task.id)).history.at(-1)).toMatchObject({ kind: 'extension_approved', by: CTO });
    await t.as(CTO).post(`${API}/extensions/${approved.id}/reject`).send({ reason: 'Changed my mind' }).expect(409);

    await act(DEV2, task.id, 'submit').expect(200);
    await act(CTO, task.id, 'approve', { rating: 4 }).expect(200);
    expect((await eventsOf('task.approved', task.number))[0].payload).toMatchObject({ deadline: newDeadline(), originalDeadline: task.deadline, extensionsCount: 1, onTime: true });
  });

  it('a request after the deadline still goes through but counts as late', async () => {
    const old = await seedTask({ assignee: DEV3, status: 'in_progress' });
    const res = await t.as(DEV3).post(`${API}/tasks/${old.id}/extensions`).send({ requestedDeadline: inDays(2), reason: 'The server was down' }).expect(201);
    expect(res.body.late).toBe(true);
    await t.as(CTO).post(`${API}/extensions/${res.body.id}/approve`).send({}).expect(200);
    expect((await detail(DEV3, old.id)).task.isOverdue).toBe(false); // the deadline moved
    expect((await eventsOf('task.extension_decided', old.number))[0].payload).toMatchObject({ late: true, decision: 'approved' });
  });

  it('on-time is measured against the approved deadline, but an extension asked for AFTER the deadline counts as late: it does not rescue a task that was already late', async () => {
    const old = await seedTask({ assignee: DEV3, status: 'in_progress' }); // its deadline was a day ago
    const ext: ExtensionBody = (await t.as(DEV3).post(`${API}/tasks/${old.id}/extensions`).send({ requestedDeadline: inDays(2), reason: 'The server was down' }).expect(201)).body;
    expect(ext.late).toBe(true);
    await t.as(CTO).post(`${API}/extensions/${ext.id}/approve`).send({}).expect(200);
    await act(DEV3, old.id, 'submit').expect(200); // handed in before the new deadline, but after the one it was asked for at
    await act(CTO, old.id, 'approve', { rating: 4 }).expect(200);
    expect((await eventsOf('task.approved', old.number))[0].payload).toMatchObject({ onTime: false, extensionsCount: 1 });

    const late = await seedTask({ assignee: DEV3, status: 'in_progress' }); // no extension: the deadline passed a day ago
    await act(DEV3, late.id, 'submit').expect(200);
    await act(CTO, late.id, 'approve', { rating: 4 }).expect(200);
    expect((await eventsOf('task.approved', late.number))[0].payload).toMatchObject({ onTime: false, extensionsCount: 0 });
  });

  it('an approval is refused (409 extension_outdated) once the deadline has moved past the date asked for; the request can still be turned down', async () => {
    const task = await create(CTO, { assignee: SQA1, deadline: inDays(10) });
    const asked = new Date(new Date(task.deadline).getTime() + 3 * DAY).toISOString();
    const ext: ExtensionBody = (await t.as(SQA1).post(`${API}/tasks/${task.id}/extensions`).send({ requestedDeadline: asked, reason: 'Waiting for the API keys' }).expect(201)).body;
    await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ deadline: inDays(30), reason: 'The client moved the date' }).expect(200);
    const refused = await t.as(CTO).post(`${API}/extensions/${ext.id}/approve`).send({}).expect(409);
    expect(refused.body.code).toBe('extension_outdated');
    expect((await prisma.taskExtension.findUniqueOrThrow({ where: { id: ext.id } })).status).toBe('pending');
    expect((await t.as(CTO).post(`${API}/extensions/${ext.id}/reject`).send({ reason: 'The date already moved' }).expect(200)).body.status).toBe('rejected');
  });

  it('cannot ask for more time on a task that is waiting for its reviewer, or approved', async () => {
    const waiting = await submitted(CTO, DEV2);
    expect((await t.as(DEV2).post(`${API}/tasks/${waiting.id}/extensions`).send({ requestedDeadline: inDays(30), reason: 'Too late now' }).expect(409)).body.code).toBe('invalid_state');
  });
});

// ------------------------------------------------------------------------------------------------ manager changes

describe('M5 the assigner edits a task, reassigns it down the line and moves its deadline', () => {
  it('moves a deadline with a reason: the first deadline is kept and the change is in the history, audit and events', async () => {
    const task = await create(CTO, { assignee: DEV2 });
    const next = inDays(20);
    const res = await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ deadline: next, reason: 'The client moved the launch' }).expect(200);
    expect(res.body).toMatchObject({ deadline: next, originalDeadline: task.deadline });
    const history = (await detail(CTO, task.id)).history.at(-1);
    expect(history).toMatchObject({ kind: 'deadline_changed', by: CTO, reason: 'The client moved the launch', details: { fromDeadline: task.deadline, toDeadline: next } });
    expect(await auditOf('task.deadline.changed', task.number)).toHaveLength(1);
    expect((await eventsOf('task.deadline_changed', task.number))[0].payload).toMatchObject({ kind: 'manager_change', reason: 'The client moved the launch', assignee: DEV2 });
  });

  it('refuses a deadline change without a reason, in the past, unchanged, by someone else, or on a closed task', async () => {
    const task = await create(CTO, { assignee: DEV2 });
    await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ deadline: inDays(12) }).expect(400);
    await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ deadline: inDays(12), reason: 'x' }).expect(400);
    expect((await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ deadline: at(-DAY), reason: 'Back in time' }).expect(400)).body.code).toBe('deadline_in_past');
    expect((await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ deadline: task.deadline, reason: 'Same date again' }).expect(400)).body.code).toBe('deadline_unchanged');
    await t.as(DEV2).patch(`${API}/tasks/${task.id}`).send({ deadline: inDays(12), reason: 'I need more time' }).expect(403);
    await t.as(DIRECTOR).patch(`${API}/tasks/${task.id}`).send({ deadline: inDays(12), reason: 'Not my task to move' }).expect(403);
    await t.as(DEV1).patch(`${API}/tasks/${task.id}`).send({ deadline: inDays(12), reason: 'Not mine at all' }).expect(404);
    await act(CTO, task.id, 'cancel', { reason: 'Not needed any more' }).expect(200);
    expect((await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ deadline: inDays(12), reason: 'Too late to move' }).expect(409)).body.code).toBe('task_closed');
    expect((await detail(CTO, task.id)).task.deadline).toBe(task.deadline);
  });

  it('a new deadline shorter than the size usually needs asks for a confirmation first', async () => {
    const task = await create(CTO, { assignee: DEV2, size: 'M', deadline: inDays(14) });
    const short = at(2 * HOUR);
    const res = await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ deadline: short, reason: 'Urgent request from the client' }).expect(409);
    expect(res.body).toMatchObject({ code: 'confirmation_required' });
    expect(res.body.warnings[0].code).toBe('deadline_too_short');
    expect((await detail(CTO, task.id)).task.deadline).toBe(task.deadline);
    await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ deadline: short, reason: 'Urgent request from the client', confirmWarnings: true }).expect(200);
  });

  it('edits the fields and reassigns only to someone below the assigner; the size and its points never change', async () => {
    const task = await create(CTO, { assignee: DEV2 });
    const edited = await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ title: 'Fix the login bug on mobile', priority: 'urgent', estimatedHours: 2 }).expect(200);
    expect(edited.body).toMatchObject({ title: 'Fix the login bug on mobile', priority: 'urgent', estimatedHours: 2, size: 'S', points: 2 });
    expect((await detail(CTO, task.id)).history.at(-1)).toMatchObject({ kind: 'edited', details: { fields: ['title', 'priority', 'estimatedHours'] } });
    const audit = await auditOf('task.updated', task.number);
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ before: { priority: 'medium' }, after: { priority: 'urgent' } });

    await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ size: 'L' }).expect(400); // not a field that can change
    await t.as(DEV2).patch(`${API}/tasks/${task.id}`).send({ title: 'My own title' }).expect(403);

    const moved = await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ assignee: DEV3, reason: 'Mariam is on leave' }).expect(200);
    expect(moved.body.assignee).toBe(DEV3);
    expect((await detail(CTO, task.id)).history.at(-1)).toMatchObject({ kind: 'reassigned', by: CTO, details: { fromEmpId: DEV2, toEmpId: DEV3 } });
    await t.as(DEV2).get(`${API}/tasks/${task.id}`).expect(404); // the old assignee no longer sees it
    await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ assignee: SALES1 }).expect(403); // not in the CTO's line
    await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ assignee: DIRECTOR }).expect(403);
    await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ assignee: CTO }).expect(403);
  });

  it('a task that is waiting for its review cannot be handed to someone else', async () => {
    const task = await submitted(CTO, DEV2);
    expect((await t.as(CTO).patch(`${API}/tasks/${task.id}`).send({ assignee: DEV3 }).expect(409)).body.code).toBe('invalid_state');
  });

  it('keeps a checklist: the person doing the task ticks, the assigner or the person adds steps, nobody else', async () => {
    const task = await create(CTO, { assignee: DEV2, checklist: ['Reproduce it', 'Fix it'] });
    const [a, b] = task.checklist;
    expect((await t.as(DEV2).patch(`${API}/tasks/${task.id}/checklist/${a.id}`).expect(200)).body).toMatchObject({ id: a.id, done: true });
    expect((await t.as(DEV2).patch(`${API}/tasks/${task.id}/checklist/${a.id}`).expect(200)).body.done).toBe(false); // ticking again unticks
    await t.as(CTO).patch(`${API}/tasks/${task.id}/checklist/${b.id}`).expect(403); // the assigner does not tick for the person
    await t.as(DEV1).patch(`${API}/tasks/${task.id}/checklist/${b.id}`).expect(404);
    const added = await t.as(CTO).post(`${API}/tasks/${task.id}/checklist`).send({ text: 'Write a test' }).expect(201);
    expect(added.body).toMatchObject({ text: 'Write a test', done: false });
    await t.as(DEV2).post(`${API}/tasks/${task.id}/checklist`).send({ text: 'Deploy it' }).expect(201);
    await t.as(DIRECTOR).post(`${API}/tasks/${task.id}/checklist`).send({ text: 'Not mine' }).expect(403);
    const positions = (await prisma.taskChecklistItem.findMany({ where: { taskId: task.id }, orderBy: { position: 'asc' } })).map((i) => [i.position, i.text]);
    expect(positions).toEqual([[0, 'Reproduce it'], [1, 'Fix it'], [2, 'Write a test'], [3, 'Deploy it']]);
    await act(CTO, task.id, 'cancel', { reason: 'Dropped' }).expect(200);
    await t.as(DEV2).patch(`${API}/tasks/${task.id}/checklist/${b.id}`).expect(409); // closed
  });

  it('a repeating series is made with the task and stopped by the assigner (once)', async () => {
    const task = await create(CTO, { assignee: DEV2, title: 'Weekly report', repeat: { every: 'week', on: 1 } });
    expect(task.repeat).toMatchObject({ every: 'week', on: 1, active: true });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id }, include: { repeatRule: true } });
    expect(row.repeatRuleId).not.toBeNull();
    expect(row.occurrenceOn?.toISOString().slice(0, 10)).toBe(pakistanDay(new Date(row.startDate)));
    expect(row.repeatRule).toMatchObject({ every: 'week', on: 1, active: true, assigneeId: row.assigneeId, title: 'Weekly report' });
    expect((await eventsOf('task.created', task.number))[0].payload).toMatchObject({ repeatRuleId: row.repeatRuleId });

    await t.as(DEV2).post(`${API}/tasks/${task.id}/repeat/stop`).send({}).expect(403);
    const stopped = await t.as(CTO).post(`${API}/tasks/${task.id}/repeat/stop`).send({ reason: 'The report is no longer needed' }).expect(200);
    expect(stopped.body.repeat).toMatchObject({ active: false });
    expect((await t.as(CTO).post(`${API}/tasks/${task.id}/repeat/stop`).send({}).expect(409)).body.code).toBe('already_stopped');
    expect((await detail(CTO, task.id)).history.at(-1)).toMatchObject({ kind: 'repeat_stopped', by: CTO });
    const plain = await create(CTO, { assignee: DEV2 });
    expect((await t.as(CTO).post(`${API}/tasks/${plain.id}/repeat/stop`).send({}).expect(409)).body.code).toBe('not_repeating');
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ repeat: { every: 'week', on: 9 } })).expect(400);
    await t.as(CTO).post(`${API}/tasks`).send(taskBody({ repeat: { every: 'month', on: 5, until: pakistanDay(new Date(Date.now() - 3 * DAY)) } })).expect(400); // ends before it starts
  });
});

describe('M5 a repeating series that starts in the past', () => {
  it('stands at today, not at its first day, so the job never makes tasks for days that are already over', async () => {
    const task = await create(CTO, { assignee: SQA1, title: 'Weekly report from the past', startDate: at(-3 * DAY), deadline: inDays(5), repeat: { every: 'week', on: 1 } });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id }, include: { repeatRule: true } });
    expect(row.occurrenceOn?.toISOString().slice(0, 10)).toBe(pakistanDay(new Date(row.startDate))); // the first task keeps its own day
    expect(row.repeatRule?.lastOccurrenceOn?.toISOString().slice(0, 10)).toBe(pakistanDay(t.clock.now()));
    const future = await create(CTO, { assignee: SQA1, title: 'Weekly report from next week', startDate: inDays(7), deadline: inDays(10), repeat: { every: 'week', on: 1 } });
    const ahead = await prisma.task.findUniqueOrThrow({ where: { id: future.id }, include: { repeatRule: true } });
    expect(ahead.repeatRule?.lastOccurrenceOn?.toISOString().slice(0, 10)).toBe(pakistanDay(new Date(ahead.startDate))); // a start in the future is kept
  });
});

// ------------------------------------------------------------------------------------------------ comments and files

describe('M5 comments with @mentions, and files', () => {
  let task: TaskBody;

  it('stores a comment and its mentions: people who can see the task, by first name, full name or Emp-ID, never the writer', async () => {
    task = await create(CTO, { assignee: DEV2 });
    const res = await t.as(DEV2).post(`${API}/tasks/${task.id}/comments`).send({ body: 'Thanks @Omar, @ACV-0003 FYI. @Fahad Khan @Hira @Mariam' }).expect(201);
    // Omar (the CTO) and the Director (by Emp-ID) can see the task; Fahad (a peer) and Hira (Sales) cannot; Mariam is the writer.
    expect(res.body).toMatchObject({ taskId: task.id, author: DEV2 });
    expect([...res.body.mentions].sort()).toEqual([DIRECTOR, CTO].sort());
    const events = await eventsOf('task.comment_added', task.number);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ commentId: res.body.id, assignee: DEV2, assignedBy: CTO, mentions: [CTO, DIRECTOR] });
    expect(await prisma.taskCommentMention.count({ where: { commentId: res.body.id } })).toBe(2);
    expect(await auditOf('task.comment.added', task.number)).toHaveLength(1);

    const listed: Array<{ author: string }> = (await t.as(CTO).get(`${API}/tasks/${task.id}/comments`).expect(200)).body;
    expect(listed).toHaveLength(1);
    expect((await detail(DIRECTOR, task.id)).comments).toHaveLength(1);
  });

  it('the assigner and the Director may comment; a person who cannot see the task cannot, and the Owner only watches', async () => {
    await t.as(CTO).post(`${API}/tasks/${task.id}/comments`).send({ body: 'Please add a test' }).expect(201);
    await t.as(DIRECTOR).post(`${API}/tasks/${task.id}/comments`).send({ body: 'Good progress' }).expect(201);
    await t.as(DEV1).post(`${API}/tasks/${task.id}/comments`).send({ body: 'Can I help?' }).expect(404);
    await t.as(OWNER).post(`${API}/tasks/${task.id}/comments`).send({ body: 'Watching' }).expect(403);
    await t.as(DEV2).post(`${API}/tasks/${task.id}/comments`).send({ body: '   ' }).expect(400);
    const all = (await t.as(CTO).get(`${API}/tasks/${task.id}/comments`).expect(200)).body as Array<{ author: string }>;
    expect(all.map((c) => c.author)).toEqual([DEV2, CTO, DIRECTOR]); // oldest first
  });

  it('adds a file with a comment (multipart): checked by its content, stored privately under a generated name', async () => {
    const res = await t.as(DEV2).post(`${API}/tasks/${task.id}/comments`).field('body', 'Here is the screenshot').attach('file', PNG, 'shot.png').expect(201);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0]).toMatchObject({ fileName: 'shot.png', mimeType: 'image/png', uploadedBy: DEV2 });
    const row = await prisma.taskAttachment.findUniqueOrThrow({ where: { id: res.body.attachments[0].id } });
    expect(row.commentId).toBe(res.body.id);
    expect(row.storageKey).toMatch(/^tasks\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
    expect(row.storageKey).not.toContain('shot');
    expect(existsSync(join(t.storageRoot, row.storageKey))).toBe(true);
    await t.as(DEV2).post(`${API}/tasks/${task.id}/comments`).field('body', 'Not a picture').attach('file', EXE, 'virus.png').expect(400);
  });

  it('attaches a file to the task: the person doing it or its assigner; downloads re-check access and are logged; archiving keeps the file', async () => {
    const res = await t.as(DEV2).post(`${API}/tasks/${task.id}/attachments`).attach('file', PDF, 'notes.pdf').expect(201);
    expect(res.body).toMatchObject({ fileName: 'notes.pdf', mimeType: 'application/pdf', uploadedBy: DEV2 });
    expect((await detail(CTO, task.id)).task.attachments.map((a: { fileName: string }) => a.fileName)).toEqual(['notes.pdf']);
    await t.as(CTO).post(`${API}/tasks/${task.id}/attachments`).attach('file', PNG, 'spec.png').expect(201);
    await t.as(DIRECTOR).post(`${API}/tasks/${task.id}/attachments`).attach('file', PNG, 'mine.png').expect(403); // sees it, does not work on it
    await t.as(DEV1).post(`${API}/tasks/${task.id}/attachments`).attach('file', PNG, 'mine.png').expect(404);
    await t.as(DEV2).post(`${API}/tasks/${task.id}/attachments`).attach('file', EXE, 'tool.exe').expect(400);
    await t.as(DEV2).post(`${API}/tasks/${task.id}/attachments`).expect(400); // no file

    const file = await download(CTO, task.id, res.body.id).expect(200);
    expect(Buffer.compare(file.body as Buffer, PDF)).toBe(0);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.headers['content-disposition']).toContain('attachment');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toContain('no-store');
    expect(await auditOf('task.attachment.downloaded', task.number)).toHaveLength(1);
    await download(DEV1, task.id, res.body.id).expect(404);
    await download(CTO, (await create(CTO, { assignee: DEV3 })).id, res.body.id).expect(404); // a file is only reachable through its own task

    await t.as(DIRECTOR).delete(`${API}/tasks/${task.id}/attachments/${res.body.id}`).expect(403);
    await t.as(CTO).delete(`${API}/tasks/${task.id}/attachments/${res.body.id}`).expect(200); // the assigner may archive
    await download(DEV2, task.id, res.body.id).expect(404);
    const row = await prisma.taskAttachment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.archivedAt).not.toBeNull();
    expect(existsSync(join(t.storageRoot, row.storageKey))).toBe(true); // archived, never deleted
    expect((await detail(CTO, task.id)).task.attachments.map((a: { fileName: string }) => a.fileName)).toEqual(['spec.png']);
  });

  it('refuses new files on a closed task', async () => {
    const done = await create(CTO, { assignee: DEV2 });
    await act(CTO, done.id, 'cancel', { reason: 'Dropped' }).expect(200);
    await t.as(DEV2).post(`${API}/tasks/${done.id}/attachments`).attach('file', PDF, 'late.pdf').expect(409);
  });
});

// ------------------------------------------------------------------------------------------------ the size table

describe('M5 the size table and the holiday calendar', () => {
  it('everyone reads the table, the projects and the holidays', async () => {
    const rules: Array<{ size: string; hours: number; points: number; days: number | null }> = (await t.as(DEV1).get(`${API}/settings/task-sizes`).expect(200)).body;
    expect(rules.map((r) => [r.size, r.hours, r.points, r.days])).toEqual([['XS', 2, 1, 0], ['S', 4, 2, 1], ['M', 16, 3, 3], ['L', 40, 5, 7], ['XL', 48, 0, null]]);
    const holidays: Array<{ date: string; name: string }> = (await t.as(DEV1).get(`${API}/holidays?year=2026`).expect(200)).body;
    expect(holidays.map((h) => h.date)).toContain('2026-12-25');
    expect(holidays.every((h) => h.date.startsWith('2026-'))).toBe(true);
    expect((await t.as(DEV1).get(`${API}/holidays?year=2027`).expect(200)).body.map((h: { date: string }) => h.date)).toContain('2027-02-05');
    expect(Array.isArray((await t.as(DEV1).get(`${API}/holidays`).expect(200)).body)).toBe(true); // this year by default
    await t.anonymous().get(`${API}/settings/task-sizes`).expect(401);
  });

  it('only the Director changes a row (a reason is required): old tasks keep their points, new ones use the new table, the history keeps who and why', async () => {
    const old = await create(CTO, { assignee: SQA1, size: 'M', deadline: inDays(14) });
    expect(old.points).toBe(3);
    await t.as(CTO).patch(`${API}/settings/task-sizes/M`).send({ points: 4, reason: 'Not the CTO to decide' }).expect(403);
    await t.as(DEV1).patch(`${API}/settings/task-sizes/M`).send({ points: 4, reason: 'Not a developer either' }).expect(403);
    await t.as(OWNER).patch(`${API}/settings/task-sizes/M`).send({ points: 4, reason: 'The Owner only watches' }).expect(403);
    await t.as(DIRECTOR).patch(`${API}/settings/task-sizes/M`).send({ points: 4 }).expect(400); // no reason

    const res = await t.as(DIRECTOR).patch(`${API}/settings/task-sizes/M`).send({ points: 4, hours: 18, reason: 'Our M tasks are bigger than we thought' }).expect(200);
    expect(res.body).toMatchObject({ size: 'M', points: 4, hours: 18, days: 3 });
    const fresh = await create(CTO, { assignee: SQA1, size: 'M', deadline: inDays(14) });
    expect(fresh.points).toBe(4);
    expect((await detail(CTO, old.id)).task.points).toBe(3); // frozen at creation

    const changes: Array<{ size: string; changedBy: string; reason: string; before: { points: number; hours: number }; after: { points: number; hours: number } }> = (await t.as(DIRECTOR).get(`${API}/settings/task-sizes/changes`).expect(200)).body;
    expect(changes[0]).toMatchObject({ size: 'M', changedBy: DIRECTOR, reason: 'Our M tasks are bigger than we thought', before: { points: 3, hours: 16 }, after: { points: 4, hours: 18 } });
    await t.as(DEV1).get(`${API}/settings/task-sizes/changes`).expect(403);
    expect(await prisma.auditLog.count({ where: { action: 'task.size_rules.changed', targetId: 'M' } })).toBe(1);

    await t.as(DIRECTOR).patch(`${API}/settings/task-sizes/M`).send({ points: 3, hours: 16, reason: 'Back to the plan table' }).expect(200); // restore
    expect((await t.as(DIRECTOR).get(`${API}/settings/task-sizes/changes`).expect(200)).body).toHaveLength(2);
  });

  it('keeps the table sensible: XL stays "must be split", a bigger size is never smaller, nothing changes without a change', async () => {
    const invalid = async (size: string, body: Record<string, unknown>) => (await t.as(DIRECTOR).patch(`${API}/settings/task-sizes/${size}`).send({ reason: 'Trying a change', ...body }).expect(400)).body.code;
    expect(await invalid('XL', { days: 5 })).toBe('invalid_size_table');
    expect(await invalid('M', { points: 1 })).toBe('invalid_size_table'); // fewer points than S
    expect(await invalid('S', { hours: 20 })).toBe('invalid_size_table'); // more hours than M
    expect(await invalid('M', { points: 3 })).toBe('nothing_changed');
    await t.as(DIRECTOR).patch(`${API}/settings/task-sizes/M`).send({ reason: 'Nothing at all' }).expect(400);
    await t.as(DIRECTOR).patch(`${API}/settings/task-sizes/XXL`).send({ points: 3, reason: 'No such size' }).expect(400);
    expect((await t.as(DEV1).get(`${API}/settings/task-sizes`).expect(200)).body.find((r: { size: string }) => r.size === 'M')).toMatchObject({ hours: 16, points: 3, days: 3 });
  });
});

// ------------------------------------------------------------------------------------------------ the approvals inbox

describe('M5 approvals inbox: task reviews and extension requests', () => {
  it('lists a submitted task for its reviewer only, with the rating prompt, and nobody else sees it as theirs', async () => {
    const task = await submitted(CTO, DEV2, { title: 'Inbox task' });
    const mine: { items: Array<{ id: string; type: string; refId: string; refNumber: string; title: string; subtitle: string; requester: string; needsRating?: boolean; approveLabel?: string; rejectLabel?: string; href: string }>; routedUp: number } = (await t.as(CTO).get(`${API}/approvals`).expect(200)).body;
    const item = mine.items.find((i) => i.id === `task_review:${task.id}`);
    expect(item).toMatchObject({ type: 'task_review', refId: task.id, refNumber: task.number, title: 'Inbox task', requester: DEV2, needsRating: true, approveLabel: 'Approve', rejectLabel: 'Send to rework', href: `/tasks/${task.id}` });
    expect(item?.subtitle).toBe('S task · 2 pts · submitted by Mariam Shah');
    for (const who of [DEV2, DEV1, SALES1, FINANCE, OWNER]) expect(((await t.as(who).get(`${API}/approvals`).expect(200)).body.items as Array<{ id: string }>).some((i) => i.id === `task_review:${task.id}`)).toBe(false);
    // The Director only WATCHES what waits for the CTO (it is not his decision)
    expect(((await t.as(DIRECTOR).get(`${API}/approvals`).expect(200)).body.items as Array<{ id: string }>).some((i) => i.id === `task_review:${task.id}`)).toBe(false);
    const watched: Array<{ id: string; waitingFor?: string }> = (await t.as(DIRECTOR).get(`${API}/approvals/oversight`).expect(200)).body;
    expect(watched.find((i) => i.id === `task_review:${task.id}`)?.waitingFor).toBe(CTO);
    expect(((await t.as(OWNER).get(`${API}/approvals/oversight`).expect(200)).body as Array<{ id: string }>).some((i) => i.id === `task_review:${task.id}`)).toBe(true);
    expect(await t.as(DEV1).get(`${API}/approvals/oversight`).expect(200).then((r) => r.body)).toEqual([]);
  });

  it('approves with a rating and sends to rework with a reason through the inbox, by the same rules as the task page', async () => {
    const a = await submitted(CTO, DEV2);
    const b = await submitted(CTO, DEV3);
    const post = (who: string, id: string, decision: 'approve' | 'reject', body: Record<string, unknown> = {}) => t.as(who).post(`${API}/approvals/${encodeURIComponent(id)}/${decision}`).send(body);
    expect((await post(CTO, `task_review:${a.id}`, 'approve', {})).status).toBe(400); // a rating is needed
    expect((await post(DEV2, `task_review:${a.id}`, 'approve', { rating: 5 })).status).toBe(403); // not waiting for the assignee
    expect((await post(DIRECTOR, `task_review:${a.id}`, 'approve', { rating: 5 })).status).toBe(403);
    const ok = await post(CTO, `task_review:${a.id}`, 'approve', { rating: 4, comment: 'Good' });
    expect(ok.status).toBeLessThan(300);
    expect(ok.body).toEqual({ ok: true });
    expect(await statusOf(a.id)).toBe('approved');
    expect((await prisma.taskReview.findFirstOrThrow({ where: { taskId: a.id } })).rating).toBe(4);

    expect((await post(CTO, `task_review:${b.id}`, 'reject', {})).status).toBe(400); // a reason is needed
    expect((await post(CTO, `task_review:${b.id}`, 'reject', { reason: 'Please add tests' })).status).toBeLessThan(300);
    expect(await statusOf(b.id)).toBe('rework');
    expect((await post(CTO, `task_review:${a.id}`, 'approve', { rating: 5 })).status).toBe(403); // no longer waiting: gone from the inbox
  });

  it('lists a pending extension for the assigner, shows the person who asked how many are waiting, and decides it through the inbox', async () => {
    const task = await create(CTO, { assignee: DEV2 });
    const wanted = inDays(14);
    const ext: ExtensionBody = (await t.as(DEV2).post(`${API}/tasks/${task.id}/extensions`).send({ requestedDeadline: wanted, reason: 'The tests take longer' }).expect(201)).body;
    const inbox: { items: Array<{ id: string; type: string; refId: string; refNumber: string; title: string; subtitle: string; requester: string; from?: string; to?: string; href: string }>; routedUp: number } = (await t.as(CTO).get(`${API}/approvals`).expect(200)).body;
    const item = inbox.items.find((i) => i.id === `extension:${ext.id}`);
    expect(item).toMatchObject({ type: 'extension', refId: ext.id, refNumber: task.number, requester: DEV2, from: task.deadline, to: wanted, href: `/tasks/${task.id}` });
    expect(item?.title).toBe('More time for “Fix the login bug”');
    expect(item?.subtitle).toContain('“The tests take longer”');
    expect(item?.subtitle).not.toContain('counts as late');
    // the person who asked has no decision to make, but sees that a request is waiting on someone else
    const asker: { items: Array<{ id: string }>; routedUp: number } = (await t.as(DEV2).get(`${API}/approvals`).expect(200)).body;
    expect(asker.items.some((i) => i.id === `extension:${ext.id}`)).toBe(false);
    expect(asker.routedUp).toBeGreaterThanOrEqual(1);
    expect(((await t.as(DIRECTOR).get(`${API}/approvals/oversight`).expect(200)).body as Array<{ id: string; waitingFor?: string }>).find((i) => i.id === `extension:${ext.id}`)?.waitingFor).toBe(CTO);

    const res = await t.as(CTO).post(`${API}/approvals/${encodeURIComponent(`extension:${ext.id}`)}/reject`).send({}).expect(400); // a reason is needed
    expect(res.body.code).toBe('reason_required');
    const ok = await t.as(CTO).post(`${API}/approvals/${encodeURIComponent(`extension:${ext.id}`)}/approve`).send({});
    expect(ok.status).toBeLessThan(300);
    expect((await detail(DEV2, task.id)).task).toMatchObject({ deadline: wanted, extensionsCount: 1 });
    expect(((await t.as(CTO).get(`${API}/approvals`).expect(200)).body.items as Array<{ id: string }>).some((i) => i.id === `extension:${ext.id}`)).toBe(false);
  });

  it('marks a request made after the deadline as late in its inbox line', async () => {
    const old = await seedTask({ assignee: DEV3, status: 'in_progress' });
    const ext: ExtensionBody = (await t.as(DEV3).post(`${API}/tasks/${old.id}/extensions`).send({ requestedDeadline: inDays(5), reason: 'The server was down' }).expect(201)).body;
    const item = ((await t.as(CTO).get(`${API}/approvals`).expect(200)).body.items as Array<{ id: string; subtitle: string }>).find((i) => i.id === `extension:${ext.id}`);
    expect(item?.subtitle).toContain('asked after the deadline (counts as late)');
  });
});

// ------------------------------------------------------------------------------------------------ stand-ins

describe('M5 the reviewer follows M1 stand-in rules', () => {
  const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
  let standInId = '';

  it('while the assigner is away the stand-in reviews; the assigner cannot, and the stand-in sees the review in the inbox', async () => {
    const task = await submitted(CTO, DEV2);
    expect((await detail(DEV2, task.id)).reviewer).toBe(CTO);
    standInId = (await t.as(CTO).post(`${API}/stand-ins`).send({ standInEmpId: DIRECTOR, startsOn: day(-1), endsOn: day(2), reason: 'Annual leave' }).expect(201)).body.id;

    expect((await detail(DEV2, task.id)).reviewer).toBe(DIRECTOR);
    await act(CTO, task.id, 'approve', { rating: 5 }).expect(403); // away
    expect(((await t.as(DIRECTOR).get(`${API}/approvals`).expect(200)).body.items as Array<{ id: string }>).some((i) => i.id === `task_review:${task.id}`)).toBe(true);
    expect(((await t.as(CTO).get(`${API}/approvals`).expect(200)).body.items as Array<{ id: string }>).some((i) => i.id === `task_review:${task.id}`)).toBe(false);
    expect((await act(DIRECTOR, task.id, 'approve', { rating: 5 }).expect(200)).body.status).toBe('approved');
    const review = await prisma.taskReview.findFirstOrThrow({ where: { taskId: task.id }, include: { reviewer: true } });
    expect(review.reviewer.empId).toBe(DIRECTOR);
  });

  it('a stand-in can also decide an extension request while the assigner is away', async () => {
    const task = await create(CTO, { assignee: DEV3 });
    const ext: ExtensionBody = (await t.as(DEV3).post(`${API}/tasks/${task.id}/extensions`).send({ requestedDeadline: inDays(20), reason: 'Waiting for the design' }).expect(201)).body;
    await t.as(CTO).post(`${API}/extensions/${ext.id}/approve`).send({}).expect(403); // away
    await t.as(DIRECTOR).post(`${API}/extensions/${ext.id}/approve`).send({}).expect(200);
  });

  it('the assigner is back once the away period ends; away with nobody named, the review goes one level up', async () => {
    await t.as(CTO).delete(`${API}/stand-ins/${standInId}`).send({ reason: 'Back early' }).expect(200);
    const task = await submitted(CTO, DEV2);
    expect((await detail(DEV2, task.id)).reviewer).toBe(CTO);

    const away = (await t.as(CTO).post(`${API}/stand-ins`).send({ startsOn: day(-1), endsOn: day(2), reason: 'Away, nobody covering' }).expect(201)).body.id;
    expect((await detail(DEV2, task.id)).reviewer).toBe(DIRECTOR); // one level up
    await act(CTO, task.id, 'approve', { rating: 5 }).expect(403);
    await act(DIRECTOR, task.id, 'approve', { rating: 5 }).expect(200);
    await t.as(CTO).delete(`${API}/stand-ins/${away}`).send({ reason: 'Back from leave' }).expect(200);
    const again = await submitted(CTO, DEV2);
    expect((await detail(DEV2, again.id)).reviewer).toBe(CTO);
  });
});

// ------------------------------------------------------------------------------------------------ an assigner who left

describe('M5 tasks assigned by someone who has left: the next person up the line acts as the assigner', () => {
  let manager: { id: string; empId: string };
  let dev: { id: string; empId: string };
  const today = () => new Date(`${pakistanDay(t.clock.now())}T00:00:00.000Z`);
  /** A task a manager assigned to a developer of his, written straight into the database. */
  const row = (over: Record<string, unknown> = {}) =>
    prisma.task.create({
      data: {
        number: `TSK-${++seeded}`,
        title: 'Left behind',
        assigneeId: dev.id,
        assignedById: manager.id,
        size: 'S',
        points: 2,
        estimatedHours: 1,
        startDate: new Date(Date.now() - 2 * DAY),
        deadline: new Date(Date.now() + 5 * DAY),
        originalDeadline: new Date(Date.now() + 5 * DAY),
        status: 'in_progress',
        ...over,
      } as never,
    });

  beforeAll(async () => {
    manager = await createEmployee(prisma, { name: 'Gone Manager', officialEmail: 'gone.manager@acevatech.com', roleKey: 'cto', reportsToEmpId: DIRECTOR });
    dev = await createEmployee(prisma, { name: 'Left Behind Developer', officialEmail: 'left.behind@acevatech.com', reportsToEmpId: manager.empId });
  });

  it('while the assigner is here and can assign, only he acts; once he left, the Director holds, resumes, moves the deadline, adds steps and cancels', async () => {
    const task = await row();
    await act(DIRECTOR, task.id, 'hold', { reason: 'Not mine to hold' }).expect(403); // he is still here
    await t.as(DIRECTOR).post(`${API}/tasks/${task.id}/checklist`).send({ text: 'Not mine' }).expect(403);
    expect((await detail(DIRECTOR, task.id)).actingAssigner).toBe(manager.empId);

    await prisma.employee.update({ where: { id: manager.id }, data: { status: 'left' } });
    expect((await detail(DIRECTOR, task.id)).actingAssigner).toBe(DIRECTOR); // the screens use this to show the assigner's buttons
    expect((await act(DIRECTOR, task.id, 'hold', { reason: 'Waiting for the client' }).expect(200)).body.status).toBe('on_hold');
    expect((await act(DIRECTOR, task.id, 'resume').expect(200)).body.status).toBe('in_progress');
    const newDeadline = inDays(8);
    const moved = await t.as(DIRECTOR).patch(`${API}/tasks/${task.id}`).send({ deadline: newDeadline, reason: 'The client moved the date' }).expect(200);
    expect(moved.body.deadline).toBe(newDeadline);
    expect((await t.as(DIRECTOR).post(`${API}/tasks/${task.id}/checklist`).send({ text: 'A new step' }).expect(201)).body).toMatchObject({ text: 'A new step' });
    expect((await t.as(DIRECTOR).patch(`${API}/tasks/${task.id}`).send({ title: 'Left behind, edited' }).expect(200)).body.title).toBe('Left behind, edited');
    expect((await act(DIRECTOR, task.id, 'cancel', { reason: 'Not needed any more' }).expect(200)).body.status).toBe('cancelled');
    const history = (await detail(DIRECTOR, task.id)).history;
    expect(history.map((h) => h.kind)).toEqual(expect.arrayContaining(['status', 'deadline_changed', 'edited']));
    expect(history.filter((h) => h.by === DIRECTOR).length).toBeGreaterThanOrEqual(5); // every change names the person who made it
  });

  it('the Owner, who only watches, and people outside the line still cannot act in his place', async () => {
    const task = await row();
    await act(OWNER, task.id, 'cancel', { reason: 'I only watch' }).expect(403);
    await t.as(OWNER).patch(`${API}/tasks/${task.id}`).send({ title: 'Changed by the Owner' }).expect(403);
    await act(CTO, task.id, 'cancel', { reason: 'Not in my line' }).expect(404); // the CTO does not see this task at all
    expect(await statusOf(task.id)).toBe('in_progress');
  });

  it('the Director also stops a repeating series the person who left had set up', async () => {
    const rule = await prisma.taskRepeatRule.create({
      data: { every: 'week', on: 1, title: 'Weekly left behind', assigneeId: dev.id, assignedById: manager.id, priority: 'medium', size: 'S', estimatedHours: 1, startTime: '09:00', durationMinutes: 540, checklist: [], lastOccurrenceOn: today() } as never,
    });
    const first = await row({ repeatRuleId: rule.id, occurrenceOn: today() });
    await t.as(DIRECTOR).post(`${API}/tasks/${first.id}/repeat/stop`).send({ reason: 'Not needed any more' }).expect(200);
    expect((await prisma.taskRepeatRule.findUniqueOrThrow({ where: { id: rule.id } })).active).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ reviewer fallbacks

describe('M5 the reviewer when the assigner has left, or when his stand-in is the person doing the task', () => {
  const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
  /** A task written straight into the database, waiting for its review. */
  const waiting = (assigneeId: string, assignedById: string) =>
    prisma.task.create({
      data: {
        number: `TSK-${++seeded}`,
        title: 'Waiting for a reviewer',
        assigneeId,
        assignedById,
        size: 'S',
        points: 2,
        estimatedHours: 1,
        startDate: new Date(Date.now() - 2 * DAY),
        deadline: new Date(Date.now() + 5 * DAY),
        originalDeadline: new Date(Date.now() + 5 * DAY),
        status: 'submitted',
      } as never,
    });
  const inboxOf = async (who: string): Promise<string[]> => ((await t.as(who).get(`${API}/approvals`).expect(200)).body.items as Array<{ id: string }>).map((i) => i.id);

  it('a task whose assigner has left is reviewed by the next level up, who sees it in the inbox and approves it', async () => {
    const boss = await createEmployee(prisma, { name: 'Review Boss', officialEmail: 'review.boss@acevatech.com', roleKey: 'cto', reportsToEmpId: DIRECTOR });
    const worker = await createEmployee(prisma, { name: 'Review Worker', officialEmail: 'review.worker@acevatech.com', reportsToEmpId: boss.empId });
    const task = await waiting(worker.id, boss.id);
    expect((await detail(DIRECTOR, task.id)).reviewer).toBe(boss.empId); // he is here: he reviews
    expect(await inboxOf(DIRECTOR)).not.toContain(`task_review:${task.id}`);

    await prisma.employee.update({ where: { id: boss.id }, data: { status: 'left' } });
    expect((await detail(DIRECTOR, task.id)).reviewer).toBe(DIRECTOR); // the next level up
    expect(await inboxOf(DIRECTOR)).toContain(`task_review:${task.id}`);
    expect((await act(DIRECTOR, task.id, 'approve', { rating: 4 }).expect(200)).body.status).toBe('approved');
    expect((await prisma.taskReview.findFirstOrThrow({ where: { taskId: task.id }, include: { reviewer: true } })).reviewer.empId).toBe(DIRECTOR);
  });

  it('a stand-in who is the person doing the task never reviews it: the review goes on to the next one in the line', async () => {
    const boss = await createEmployee(prisma, { name: 'Away Boss', officialEmail: 'away.boss@acevatech.com', roleKey: 'cto', reportsToEmpId: DIRECTOR });
    const cover = await createEmployee(prisma, { name: 'Covering Assignee', officialEmail: 'covering.assignee@acevatech.com', roleKey: 'cto', reportsToEmpId: boss.empId });
    const task = await waiting(cover.id, boss.id);
    expect((await detail(DIRECTOR, task.id)).reviewer).toBe(boss.empId);

    // Written straight into the database: the stand-in is the person the boss gave the task to (the screens do not allow naming someone below you).
    const away = await prisma.standIn.create({ data: { managerId: boss.id, standInId: cover.id, startsOn: new Date(`${day(-1)}T00:00:00.000Z`), endsOn: new Date(`${day(2)}T00:00:00.000Z`), reason: 'Away' } });
    const reviewer = (await detail(DIRECTOR, task.id)).reviewer;
    expect(reviewer).not.toBe(cover.empId); // nobody reviews their own task
    expect(reviewer).not.toBe(boss.empId); // he is away
    expect(reviewer).toBe(DIRECTOR); // the next seat up the line
    expect(await inboxOf(DIRECTOR)).toContain(`task_review:${task.id}`);
    await prisma.standIn.update({ where: { id: away.id }, data: { revokedAt: new Date() } });
  });

  it('when nobody else in the line can review it, the review waits for nobody rather than falling to the person doing the task', async () => {
    // The Director assigned a task to the CTO and is away with the CTO as the stand-in; the CEO / Founder / Owner never reviews work.
    const director = await prisma.employee.findUniqueOrThrow({ where: { empId: DIRECTOR }, select: { id: true } });
    const cto = await prisma.employee.findUniqueOrThrow({ where: { empId: CTO }, select: { id: true } });
    const task = await waiting(cto.id, director.id);
    expect((await detail(CTO, task.id)).reviewer).toBe(DIRECTOR);

    const away = await prisma.standIn.create({ data: { managerId: director.id, standInId: cto.id, startsOn: new Date(`${day(-1)}T00:00:00.000Z`), endsOn: new Date(`${day(2)}T00:00:00.000Z`), reason: 'Away' } });
    expect((await detail(CTO, task.id)).reviewer).toBeNull();
    await act(CTO, task.id, 'approve', { rating: 5 }).expect(403); // never the person doing it
    await act(DIRECTOR, task.id, 'approve', { rating: 5 }).expect(403); // away
    await act(OWNER, task.id, 'approve', { rating: 5 }).expect(403); // only watches
    expect(await statusOf(task.id)).toBe('submitted');
    await prisma.standIn.update({ where: { id: away.id }, data: { revokedAt: new Date() } });
    expect((await detail(CTO, task.id)).reviewer).toBe(DIRECTOR);
  });
});
