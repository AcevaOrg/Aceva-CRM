import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pakistanDay } from '../src/activity/rules/activity-time';
import { ActivitySummaryHooks } from '../src/activity/activity-summary.service';
import { ApprovalsService } from '../src/approvals/approvals.service';
import { OutboxDispatcher } from '../src/events/outbox-dispatcher.service';
import { OutboxService } from '../src/events/outbox.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { JobRunner } from '../src/jobs/job-runner.service';
import { OffboardingService } from '../src/people/offboarding.service';
import { addDays, isoWeekdayOf } from '../src/tasks/rules/task-deadlines';
import { dueOccurrences, occurrenceRunAt } from '../src/tasks/rules/task-repeat';
import { nextOverdueAt } from '../src/tasks/rules/task-reminders';
import { createdPayload, statusChangedPayload, TASK_INCLUDE } from '../src/tasks/task-data';
import { TaskHandover } from '../src/tasks/task-handover.service';
import { TaskReminders, type ReminderJobPayload } from '../src/tasks/task-reminders.service';
import { TaskRepeat } from '../src/tasks/task-repeat.service';
import { TaskWorkflowService } from '../src/tasks/task-workflow.service';
import { createTestApp, type TestApp } from './helpers/app';
import { createEmployee } from './helpers/people';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 5 automation: the reminders (armed, re-armed, cancelled, sent once), the repeating tasks, the leaver hand-over,
 * the task mails and the "tasks touched" hook of the M4 daily summary. Tasks are written straight into the tables (the
 * endpoints are tested in m5-core.test.ts) and the events the core would write are emitted here, so every
 * consumer, job and mail runs for real: the outbox dispatcher (tick) and the job runner (runDueJobs) are driven by hand
 * and the fake clock is moved instead of waiting.
 */
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006'; // Fahad Khan, fahad@acevatech.com
const DEV2 = 'ACV-0007'; // Mariam Shah, mariam@acevatech.com
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MARIAM = 'mariam@acevatech.com';
const FAHAD = 'fahad@acevatech.com';
const OMAR = 'omar@acevatech.com'; // the CTO

let t: TestApp;
let prisma: PrismaClient;
let outbox: OutboxService;
let dispatcher: OutboxDispatcher;
let jobs: JobRunner;
let reminders: TaskReminders;
let repeat: TaskRepeat;
let handover: TaskHandover;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestApp();
  prisma = createTestPrisma();
  outbox = t.app.get(OutboxService);
  dispatcher = t.app.get(OutboxDispatcher);
  jobs = t.app.get(JobRunner);
  reminders = t.app.get(TaskReminders);
  repeat = t.app.get(TaskRepeat);
  handover = t.app.get(TaskHandover);
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
});
// Reminder and repeat jobs armed by an earlier test must not run (by the job runner's own timer) during a later one.
beforeEach(async () => {
  await prisma.scheduledJob.deleteMany({ where: { type: { in: ['task.reminder', 'task.repeat'] }, status: 'pending' } });
});
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

// ------------------------------------------------------------------------------------------------------------ helpers

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const pkDay = () => pakistanDay(t.clock.now());

/** Runs every job that is due now and waits until the job runner's own 30-second timer (if it is running) has finished too. */
async function runDueJobs(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await jobs.tick();
    const busy = await prisma.scheduledJob.count({ where: { OR: [{ status: 'pending', runAt: { lte: t.clock.now() } }, { status: 'running' }] } });
    if (!busy) return;
    await sleep(100);
  }
  throw new Error('The jobs did not finish');
}

/** Moves the fake clock by `ms` and runs what is due, delivering the events that follow. */
async function pass(ms: number): Promise<void> {
  t.clock.advance(ms);
  await runDueJobs();
  await dispatcher.tick();
}

let seq = 8000;
async function makeTask(over: Record<string, unknown> = {}) {
  const now = t.clock.now();
  const deadline = (over.deadline as Date | undefined) ?? new Date(now.getTime() + 72 * HOUR);
  return prisma.task.create({
    data: {
      number: `TSK-${++seq}`,
      title: 'Fix login bug',
      assigneeId: ids[DEV2],
      assignedById: ids[CTO],
      size: 'M',
      points: 3,
      estimatedHours: 16,
      startDate: now,
      originalDeadline: deadline,
      ...over,
      deadline,
    } as never,
  });
}

const rowOf = (taskId: string) => prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE });

async function emitCreated(taskId: string, actor: string) {
  await outbox.emit({ type: 'task.created', actor, payload: createdPayload(await rowOf(taskId)) });
}
async function emitStatus(taskId: string, from: string, to: string, actor: string, reason: string | null = null) {
  await outbox.emit({ type: 'task.status_changed', actor, payload: statusChangedPayload(await rowOf(taskId), from as never, to as never, reason) });
}
async function setStatus(taskId: string, to: string, actor = CTO, extra: Record<string, unknown> = {}) {
  const before = await prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } });
  await prisma.task.update({ where: { id: taskId }, data: { status: to as never, ...extra } });
  await emitStatus(taskId, before.status, to, actor);
  await dispatcher.tick();
}

const pendingJobs = (taskId: string) => prisma.scheduledJob.findMany({ where: { dedupeKey: { startsWith: `task.reminder:${taskId}:` }, status: 'pending' }, orderBy: { runAt: 'asc' } });
const kindOf = (key: string) => key.split(':')[2];
const dueEvents = async (taskId: string) =>
  (await prisma.outboxEvent.findMany({ where: { type: 'task.reminder.due' }, orderBy: { occurredAt: 'asc' } })).filter((e) => (e.payload as { taskId: string }).taskId === taskId);
/** Mails whose subject starts with the words (and, when given, names the task number), optionally to one address. */
const mailsWith = (subjectStart: string, to?: string, number?: string) =>
  t.mailer.sent.filter((m) => m.subject.startsWith(subjectStart) && (!number || m.subject.endsWith(number) || m.subject.includes(`${number}:`)) && (!to || m.to === to));

// ------------------------------------------------------------------------------------------------------------ reminders

describe('reminders: armed from the task and kept in step with it', () => {
  it('a new task gets half time, 24 hours before, the deadline and the first overdue notice, and the assignee gets the assignment mail', async () => {
    const task = await makeTask();
    await emitCreated(task.id, CTO);
    t.mailer.clear();
    await dispatcher.tick();

    const armed = await pendingJobs(task.id);
    expect(armed.map((j) => kindOf(j.dedupeKey))).toEqual(['half_time', 'day_before', 'deadline', 'overdue']);
    expect(armed.every((j) => j.type === 'task.reminder')).toBe(true);
    const start = task.startDate.getTime();
    expect(armed[0].runAt.getTime()).toBe(start + 36 * HOUR); // half of 72 hours
    expect(armed[1].runAt.getTime()).toBe(start + 48 * HOUR); // deadline minus 24 hours
    expect(armed[2].runAt.getTime()).toBe(task.deadline.getTime());
    expect(armed[3].runAt.getTime()).toBe(nextOverdueAt(task.deadline, t.clock.now()).getTime()); // 09:00 Pakistan time after the deadline
    expect(armed[3].dedupeKey).toBe(`task.reminder:${task.id}:overdue:${pakistanDay(armed[3].runAt)}`);
    expect(armed[2].payload).toMatchObject({ taskId: task.id, kind: 'deadline', deadline: task.deadline.toISOString() });

    const assigned = mailsWith('New task', MARIAM);
    expect(assigned).toHaveLength(1);
    expect(assigned[0].subject).toBe(`New task ${task.number}: Fix login bug`);
    expect(assigned[0].text).toContain('Omar Farooq assigned you');
    expect(assigned[0].text).toContain(`/tasks/${task.id}`);
  });

  it('syncing twice changes nothing (no duplicate jobs)', async () => {
    const task = await makeTask();
    await reminders.sync(task.id);
    const first = await pendingJobs(task.id);
    await reminders.sync(task.id);
    const second = await pendingJobs(task.id);
    expect(second.map((j) => [j.dedupeKey, j.runAt.getTime()])).toEqual(first.map((j) => [j.dedupeKey, j.runAt.getTime()]));
    expect(await prisma.scheduledJob.count({ where: { dedupeKey: { startsWith: `task.reminder:${task.id}:` } } })).toBe(first.length);
  });

  it('a personal to-do has no reminders and its creation sends no mail', async () => {
    const todo = await makeTask({ number: `TODO-${++seq}`, personal: true, assigneeId: ids[DEV2], assignedById: ids[DEV2], points: 0, size: 'XS', estimatedHours: 1 });
    await emitCreated(todo.id, DEV2);
    t.mailer.clear();
    await dispatcher.tick();
    expect(await pendingJobs(todo.id)).toEqual([]);
    expect(t.mailer.sent).toHaveLength(0);
  });

  it('starting the task removes only the half-time reminder', async () => {
    const task = await makeTask();
    await emitCreated(task.id, CTO);
    await dispatcher.tick();
    await setStatus(task.id, 'in_progress', DEV2, { startedAt: t.clock.now() });
    expect((await pendingJobs(task.id)).map((j) => kindOf(j.dedupeKey))).toEqual(['day_before', 'deadline', 'overdue']);
  });

  it('put on hold, handed in, approved or cancelled: every pending reminder goes; resumed: they come back', async () => {
    const task = await makeTask();
    await emitCreated(task.id, CTO);
    await setStatus(task.id, 'in_progress', DEV2, { startedAt: t.clock.now() });
    expect(await pendingJobs(task.id)).toHaveLength(3);

    await setStatus(task.id, 'on_hold', CTO);
    expect(await pendingJobs(task.id)).toEqual([]);
    await setStatus(task.id, 'in_progress', CTO);
    expect(await pendingJobs(task.id)).toHaveLength(3);

    await setStatus(task.id, 'submitted', DEV2);
    expect(await pendingJobs(task.id)).toEqual([]);
    await setStatus(task.id, 'rework', CTO);
    expect((await pendingJobs(task.id)).map((j) => kindOf(j.dedupeKey))).toEqual(['day_before', 'deadline', 'overdue']);
    await setStatus(task.id, 'submitted', DEV2);
    await setStatus(task.id, 'approved', CTO);
    expect(await pendingJobs(task.id)).toEqual([]);

    const other = await makeTask();
    await emitCreated(other.id, CTO);
    await dispatcher.tick();
    expect(await pendingJobs(other.id)).toHaveLength(4);
    await setStatus(other.id, 'cancelled', CTO);
    expect(await pendingJobs(other.id)).toEqual([]);
  });

  it('a new deadline re-arms every reminder for the new time (one job per kind, no leftovers)', async () => {
    const task = await makeTask();
    await emitCreated(task.id, CTO);
    await dispatcher.tick();
    const before = await pendingJobs(task.id);
    const newDeadline = new Date(task.deadline.getTime() + 10 * DAY);
    await prisma.task.update({ where: { id: task.id }, data: { deadline: newDeadline } });
    await outbox.emit({
      type: 'task.deadline_changed',
      actor: CTO,
      payload: { taskId: task.id, number: task.number, assignee: DEV2, assignedBy: CTO, from: task.deadline.toISOString(), to: newDeadline.toISOString(), kind: 'manager_change', reason: 'Client moved the date' },
    });
    await dispatcher.tick();

    const after = await pendingJobs(task.id);
    expect(after.map((j) => kindOf(j.dedupeKey))).toEqual(['half_time', 'day_before', 'deadline', 'overdue']);
    expect(after.find((j) => kindOf(j.dedupeKey) === 'deadline')!.runAt.getTime()).toBe(newDeadline.getTime());
    expect(after.find((j) => kindOf(j.dedupeKey) === 'day_before')!.runAt.getTime()).toBe(newDeadline.getTime() - DAY);
    expect(after.find((j) => kindOf(j.dedupeKey) === 'half_time')!.runAt.getTime()).toBe(task.startDate.getTime() + (newDeadline.getTime() - task.startDate.getTime()) / 2);
    expect(after.find((j) => kindOf(j.dedupeKey) === 'overdue')!.dedupeKey).toBe(`task.reminder:${task.id}:overdue:${pakistanDay(nextOverdueAt(newDeadline, t.clock.now()))}`);
    expect(before.find((j) => kindOf(j.dedupeKey) === 'overdue')!.dedupeKey).not.toBe(after.find((j) => kindOf(j.dedupeKey) === 'overdue')!.dedupeKey);
    expect(await prisma.scheduledJob.count({ where: { dedupeKey: { startsWith: `task.reminder:${task.id}:` }, status: 'pending' } })).toBe(4);
    expect(after.find((j) => kindOf(j.dedupeKey) === 'deadline')!.payload).toMatchObject({ deadline: newDeadline.toISOString() });
  });

  it('cancelAll deletes the pending reminders of a task and nobody else\'s', async () => {
    const a = await makeTask();
    const b = await makeTask();
    await reminders.sync(a.id);
    await reminders.sync(b.id);
    await reminders.cancelAll(a.id);
    expect(await pendingJobs(a.id)).toEqual([]);
    expect(await pendingJobs(b.id)).toHaveLength(4);
  });
});

describe('reminders: what happens when the jobs run', () => {
  it('half time, 24 hours before, the deadline and then the daily overdue notice go out on time, as events and as mail', async () => {
    const task = await makeTask();
    await emitCreated(task.id, CTO);
    await dispatcher.tick();
    t.mailer.clear();
    const start = task.startDate.getTime();
    const wait = (target: number) => Math.max(0, target - t.clock.now().getTime() + 60_000);
    const firstOverdue = (await pendingJobs(task.id)).find((j) => kindOf(j.dedupeKey) === 'overdue')!.runAt;

    await pass(wait(start + 36 * HOUR));
    expect((await dueEvents(task.id)).map((e) => (e.payload as { kind: string }).kind)).toEqual(['half_time']);
    expect(mailsWith('Half the time has passed', MARIAM, task.number)).toHaveLength(1);
    expect(mailsWith('Half the time has passed', MARIAM, task.number)[0].text).toContain('has not been started');

    await pass(wait(start + 48 * HOUR));
    expect(mailsWith('Due in 24 hours', MARIAM, task.number)).toHaveLength(1);

    await pass(wait(task.deadline.getTime()));
    expect(mailsWith('Due now', MARIAM, task.number)).toHaveLength(1);
    if (firstOverdue.getTime() > t.clock.now().getTime()) expect(mailsWith('Overdue', undefined, task.number)).toHaveLength(0);

    // first overdue notice: 09:00 Pakistan time after the deadline, to the assignee, the assigner and the manager (the CTO is both)
    await pass(wait(firstOverdue.getTime()));
    const overdue = (await dueEvents(task.id)).filter((e) => (e.payload as { kind: string }).kind === 'overdue');
    expect(overdue).toHaveLength(1);
    expect(overdue[0].actor).toBe('system');
    expect(overdue[0].payload).toMatchObject({ taskId: task.id, number: task.number, recipients: [DEV2, CTO], deadline: task.deadline.toISOString() });
    expect(mailsWith('Overdue', MARIAM, task.number)).toHaveLength(1);
    expect(mailsWith('Overdue', OMAR, task.number)).toHaveLength(1);
    expect(mailsWith('Overdue', OMAR, task.number)[0].text).toContain('Mariam Shah'); // the manager's copy names the person who is late
    expect(await pendingJobs(task.id)).toHaveLength(1); // tomorrow's notice is armed

    // and again every day, until the person hands it in
    await pass(DAY);
    expect((await dueEvents(task.id)).filter((e) => (e.payload as { kind: string }).kind === 'overdue')).toHaveLength(2);
    await pass(DAY);
    expect((await dueEvents(task.id)).filter((e) => (e.payload as { kind: string }).kind === 'overdue')).toHaveLength(3);

    await setStatus(task.id, 'submitted', DEV2);
    expect(await pendingJobs(task.id)).toEqual([]);
    await pass(3 * DAY);
    expect((await dueEvents(task.id)).filter((e) => (e.payload as { kind: string }).kind === 'overdue')).toHaveLength(3); // nothing after handing in
  });

  it('a reminder that runs long after its time (the server was down) sends nothing, and the overdue notice carries on', async () => {
    const task = await makeTask();
    await reminders.sync(task.id);
    t.mailer.clear();
    await pass(10 * DAY);
    expect(await dueEvents(task.id)).toEqual([]);
    expect(t.mailer.sent.filter((m) => m.subject.includes(task.number))).toHaveLength(0);
    const next = await pendingJobs(task.id);
    expect(next.map((j) => kindOf(j.dedupeKey))).toEqual(['overdue']);
    expect(next[0].runAt.getTime()).toBeGreaterThan(t.clock.now().getTime());
  });

  it('a job whose task changed meanwhile does nothing (the status or the deadline no longer fits)', async () => {
    const task = await makeTask({ deadline: new Date(t.clock.now().getTime() + 5 * HOUR) });
    const payload: ReminderJobPayload = { taskId: task.id, kind: 'deadline', deadline: task.deadline.toISOString(), at: t.clock.now().toISOString() };
    await prisma.task.update({ where: { id: task.id }, data: { status: 'submitted' } });
    await reminders.handle(payload);
    expect(await dueEvents(task.id)).toEqual([]);
    await prisma.task.update({ where: { id: task.id }, data: { status: 'in_progress' } });
    await reminders.handle({ ...payload, deadline: new Date(task.deadline.getTime() + HOUR).toISOString() }); // armed for another deadline
    expect(await dueEvents(task.id)).toEqual([]);
    await reminders.handle(payload);
    expect(await dueEvents(task.id)).toHaveLength(1);
  });

  it('the same reminder is written once per task, kind and day, even when the job runs twice', async () => {
    const task = await makeTask({ startDate: new Date(t.clock.now().getTime() - 3 * DAY), deadline: new Date(t.clock.now().getTime() - 2 * HOUR) });
    const payload: ReminderJobPayload = { taskId: task.id, kind: 'overdue', deadline: task.deadline.toISOString(), at: t.clock.now().toISOString() };
    await reminders.handle(payload);
    await reminders.handle(payload);
    expect(await dueEvents(task.id)).toHaveLength(1);
    // the next day it is a new notice
    t.clock.advance(DAY);
    await reminders.handle({ ...payload, at: t.clock.now().toISOString() });
    expect(await dueEvents(task.id)).toHaveLength(2);
  });

  it('an overdue notice also reaches the assignee\'s manager when someone else assigned the task, and nobody who left', async () => {
    const task = await makeTask({ assignedById: ids[DIRECTOR], startDate: new Date(t.clock.now().getTime() - 3 * DAY), deadline: new Date(t.clock.now().getTime() - HOUR) });
    await reminders.handle({ taskId: task.id, kind: 'overdue', deadline: task.deadline.toISOString(), at: t.clock.now().toISOString() });
    expect((await dueEvents(task.id))[0].payload).toMatchObject({ recipients: [DEV2, DIRECTOR, CTO] });

    const gone = await createEmployee(prisma, { name: 'Gone Manager', officialEmail: 'gone.manager@acevatech.com', reportsToEmpId: DIRECTOR });
    const second = await makeTask({ assignedById: gone.id, startDate: new Date(t.clock.now().getTime() - 3 * DAY), deadline: new Date(t.clock.now().getTime() - HOUR) });
    await prisma.employee.update({ where: { id: gone.id }, data: { status: 'left' } });
    await reminders.handle({ taskId: second.id, kind: 'overdue', deadline: second.deadline.toISOString(), at: t.clock.now().toISOString() });
    expect((await dueEvents(second.id))[0].payload).toMatchObject({ recipients: [DEV2, CTO] });
    // the earlier kinds go to the person doing the task alone
    const third = await makeTask({ deadline: new Date(t.clock.now().getTime() + HOUR) });
    await reminders.handle({ taskId: third.id, kind: 'deadline', deadline: third.deadline.toISOString(), at: t.clock.now().toISOString() });
    expect((await dueEvents(third.id))[0].payload).toMatchObject({ kind: 'deadline', recipients: [DEV2] });
  });
});

// ------------------------------------------------------------------------------------------------------ repeating tasks

describe('repeating tasks', () => {
  async function makeRule(over: Record<string, unknown> = {}) {
    const today = pkDay();
    return prisma.taskRepeatRule.create({
      data: {
        every: 'week',
        on: isoWeekdayOf(today),
        title: 'Weekly report',
        description: 'Send the numbers',
        assigneeId: ids[DEV2],
        assignedById: ids[CTO],
        priority: 'medium',
        size: 'S',
        estimatedHours: 4,
        startTime: '09:00',
        durationMinutes: 540,
        checklist: ['Write the report', 'Send it'],
        lastOccurrenceOn: dayDate(today),
        ...over,
      } as never,
    });
  }
  /** The first task of a series, made the way the core makes it (it carries the rule and its day). */
  async function startSeries(rule: { id: string }, assigneeId = ids[DEV2], assignedById = ids[CTO]) {
    const first = await makeTask({ title: 'Weekly report', repeatRuleId: rule.id, occurrenceOn: dayDate(pkDay()), assigneeId, assignedById });
    await emitCreated(first.id, CTO);
    await dispatcher.tick();
    return first;
  }
  const seriesTasks = (ruleId: string) => prisma.task.findMany({ where: { repeatRuleId: ruleId }, orderBy: { occurrenceOn: 'asc' }, include: { checklist: { orderBy: { position: 'asc' } } } });
  const pendingRepeat = (ruleId: string) => prisma.scheduledJob.findMany({ where: { type: 'task.repeat', dedupeKey: { startsWith: `task.repeat:${ruleId}:` }, status: 'pending' } });

  it('the first task arms the series: one job for the next occurrence day, at 00:05 Pakistan time', async () => {
    const rule = await makeRule();
    await startSeries(rule);
    const today = pkDay();
    const armed = await pendingRepeat(rule.id);
    expect(armed.map((j) => j.dedupeKey)).toEqual([`task.repeat:${rule.id}:${addDays(today, 7)}`]);
    expect(armed[0].runAt.getTime()).toBe(occurrenceRunAt(addDays(today, 7)).getTime());
    expect(armed[0].payload).toEqual({ ruleId: rule.id });
  });

  it('on the day it makes the task from the template, with its checklist, history, event and mail, and arms the next one', async () => {
    const rule = await makeRule({ title: 'Every Monday report' });
    await startSeries(rule);
    const today = pkDay();
    const nextDay = addDays(today, 7);
    const runAt = occurrenceRunAt(nextDay);
    t.mailer.clear();

    await pass(runAt.getTime() - t.clock.now().getTime() - 60_000); // one minute before: nothing yet
    expect(await seriesTasks(rule.id)).toHaveLength(1);
    await pass(2 * 60_000); // now it is due

    const made = await seriesTasks(rule.id);
    expect(made).toHaveLength(2);
    const task = made[1];
    expect(pakistanDay(task.occurrenceOn!)).toBe(nextDay);
    expect(task.occurrenceOn!.toISOString().slice(0, 10)).toBe(nextDay);
    expect(task).toMatchObject({ title: 'Every Monday report', description: 'Send the numbers', assigneeId: ids[DEV2], assignedById: ids[CTO], size: 'S', points: 2, status: 'assigned', personal: false, createdBy: null, repeatRuleId: rule.id });
    expect(task.number).toMatch(/^TSK-\d{4,}$/);
    expect(Number(task.estimatedHours)).toBe(4);
    expect(task.startDate.getTime()).toBe(new Date(`${nextDay}T09:00:00+05:00`).getTime());
    expect(task.deadline.getTime()).toBe(task.startDate.getTime() + 540 * 60_000);
    expect(task.originalDeadline.getTime()).toBe(task.deadline.getTime());
    expect(task.checklist.map((c) => [c.position, c.text, c.done])).toEqual([[0, 'Write the report', false], [1, 'Send it', false]]);

    const history = await prisma.taskHistory.findMany({ where: { taskId: task.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: 'created', byId: null, toStatus: 'assigned' });
    const created = (await prisma.outboxEvent.findMany({ where: { type: 'task.created' } })).filter((e) => (e.payload as { taskId: string }).taskId === task.id);
    expect(created).toHaveLength(1);
    expect(created[0].actor).toBe('system');
    expect(created[0].payload).toMatchObject({ repeatRuleId: rule.id, assignee: DEV2, assignedBy: CTO, personal: false });

    expect(mailsWith('New task', MARIAM)).toHaveLength(1); // the new task is announced like any other
    expect((await pendingJobs(task.id)).length).toBeGreaterThan(0); // and gets its own reminders
    expect((await pendingRepeat(rule.id)).map((j) => j.dedupeKey)).toEqual([`task.repeat:${rule.id}:${addDays(nextDay, 7)}`]);
    expect(pakistanDay((await prisma.taskRepeatRule.findUniqueOrThrow({ where: { id: rule.id } })).lastOccurrenceOn!)).toBe(nextDay);
  });

  it('a job that runs twice never makes the same day twice', async () => {
    const rule = await makeRule();
    await startSeries(rule);
    const started = pkDay();
    await pass(8 * DAY);
    expect(await seriesTasks(rule.id)).toHaveLength(2);
    // pretend the advance of the series was lost (a crash after the task was saved): the day is skipped, not made again
    await prisma.taskRepeatRule.update({ where: { id: rule.id }, data: { lastOccurrenceOn: dayDate(started) } });
    await repeat.handle({ ruleId: rule.id });
    await repeat.handle({ ruleId: rule.id });
    const days = (await seriesTasks(rule.id)).map((x) => x.occurrenceOn!.toISOString().slice(0, 10));
    expect(days).toEqual([started, addDays(started, 7)]);
    expect(pakistanDay((await prisma.taskRepeatRule.findUniqueOrThrow({ where: { id: rule.id } })).lastOccurrenceOn!)).toBe(addDays(started, 7));
  });

  it('after a long downtime only the newest three are made, and the series catches up to the latest day', async () => {
    const rule = await makeRule();
    await startSeries(rule);
    const last = pkDay();
    t.clock.advance(40 * DAY); // nothing ran
    const today = pkDay();
    const expected = dueOccurrences({ every: 'week', on: rule.on }, last, today, 3);
    expect(expected).toHaveLength(3);
    await runDueJobs();
    await dispatcher.tick();
    const days = (await seriesTasks(rule.id)).map((x) => x.occurrenceOn!.toISOString().slice(0, 10));
    expect(days).toEqual([last, ...expected]);
    expect(pakistanDay((await prisma.taskRepeatRule.findUniqueOrThrow({ where: { id: rule.id } })).lastOccurrenceOn!)).toBe(expected[2]);
    expect(await pendingRepeat(rule.id)).toHaveLength(1); // the next one is armed
  });

  it('stops after the stop date: the last day is still made, then no job is left', async () => {
    const today = pkDay();
    const rule = await makeRule({ until: dayDate(addDays(today, 14)) });
    await startSeries(rule);
    await pass(40 * DAY);
    const days = (await seriesTasks(rule.id)).map((x) => x.occurrenceOn!.toISOString().slice(0, 10));
    expect(days).toEqual([today, addDays(today, 7), addDays(today, 14)]);
    expect(await pendingRepeat(rule.id)).toEqual([]);
    expect(await repeat.arm(rule.id)).toBe(false);
  });

  it('a series someone stopped makes nothing more and loses its pending job', async () => {
    const rule = await makeRule();
    await startSeries(rule);
    expect(await pendingRepeat(rule.id)).toHaveLength(1);
    await prisma.taskRepeatRule.update({ where: { id: rule.id }, data: { active: false, stoppedAt: new Date() } });
    await pass(8 * DAY);
    expect(await seriesTasks(rule.id)).toHaveLength(1);
    expect(await repeat.arm(rule.id)).toBe(false);
    expect(await pendingRepeat(rule.id)).toEqual([]);
  });

  it('a series whose person left stops by itself and says so in the history of its last task', async () => {
    const leaver = await createEmployee(prisma, { name: 'Series Leaver', officialEmail: 'series.leaver@acevatech.com', reportsToEmpId: CTO });
    const rule = await makeRule({ assigneeId: leaver.id });
    const first = await startSeries(rule, leaver.id);
    await prisma.employee.update({ where: { id: leaver.id }, data: { status: 'left' } });
    await pass(8 * DAY);
    expect(await seriesTasks(rule.id)).toHaveLength(1);
    const stopped = await prisma.taskRepeatRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(stopped.active).toBe(false);
    expect(stopped.stoppedAt).not.toBeNull();
    const line = await prisma.taskHistory.findFirstOrThrow({ where: { taskId: first.id, kind: 'repeat_stopped' } });
    expect(line.byId).toBeNull();
    expect(line.reason).toContain('left');
    expect(await prisma.auditLog.count({ where: { action: 'task.repeat.stopped', targetId: first.number } })).toBe(1);
    expect(await pendingRepeat(rule.id)).toEqual([]);
  });

  it('a series stops when the person doing it is no longer in the reporting line of the person who set it up, or when he can no longer assign', async () => {
    const outsider = await createEmployee(prisma, { name: 'Moved Away', officialEmail: 'moved.away@acevatech.com', reportsToEmpId: DIRECTOR }); // not below the CTO
    const away = await makeRule({ assigneeId: outsider.id });
    const firstAway = await startSeries(away, outsider.id);
    const noAssign = await makeRule({ assignedById: ids[DEV1], title: 'From a developer' }); // a developer holds no task.assign
    const firstOfOther = await startSeries(noAssign, ids[DEV2], ids[DEV1]);
    await pass(8 * DAY);
    for (const [rule, first, why] of [
      [away, firstAway, 'reporting line'],
      [noAssign, firstOfOther, 'assign'],
    ] as const) {
      expect(await seriesTasks(rule.id)).toHaveLength(1); // nothing new was made
      expect((await prisma.taskRepeatRule.findUniqueOrThrow({ where: { id: rule.id } })).active).toBe(false);
      const line = await prisma.taskHistory.findFirstOrThrow({ where: { taskId: first.id, kind: 'repeat_stopped' } });
      expect(line.byId).toBeNull();
      expect(line.reason).toContain(why);
      expect(await pendingRepeat(rule.id)).toEqual([]);
    }
  });

  it('start-up catches up: every active series without a pending job is armed again, series with one are left alone', async () => {
    const lost = await makeRule();
    const kept = await makeRule();
    await repeat.arm(kept.id);
    await prisma.scheduledJob.deleteMany({ where: { dedupeKey: { startsWith: `task.repeat:${lost.id}:` } } });
    const keptBefore = await pendingRepeat(kept.id);
    expect(await pendingRepeat(lost.id)).toEqual([]);
    const armed = await repeat.ensureArmed();
    expect(armed).toBeGreaterThanOrEqual(1);
    expect(await pendingRepeat(lost.id)).toHaveLength(1);
    expect((await pendingRepeat(kept.id)).map((j) => j.id)).toEqual(keptBefore.map((j) => j.id));
    expect(await repeat.ensureArmed()).toBe(0); // nothing left to do the second time
  });

  it('start-up also removes reminder and repeat jobs that finished more than 14 days ago, and keeps everything else', async () => {
    const now = t.clock.now();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const later = new Date(now.getTime() + 30 * DAY); // pending rows run far ahead, so no job runner tick picks them up
    let n = 0;
    const job = (type: string, over: Record<string, unknown>) =>
      prisma.scheduledJob.create({ data: { type, dedupeKey: `purge-test:${++n}`, payload: {}, runAt: later, ...over } as never });
    const rows = {
      oldReminder: await job('task.reminder', { status: 'succeeded', runAt: ago(16), completedAt: ago(15) }),
      oldRepeat: await job('task.repeat', { status: 'succeeded', runAt: ago(21), completedAt: ago(20) }),
      recentReminder: await job('task.reminder', { status: 'succeeded', runAt: ago(14), completedAt: ago(13) }),
      recentRepeat: await job('task.repeat', { status: 'succeeded', runAt: ago(1), completedAt: ago(1) }),
      pendingReminder: await job('task.reminder', { status: 'pending', createdAt: ago(40) }), // old, but it has not run: it is never removed
      pendingRepeat: await job('task.repeat', { status: 'pending', createdAt: ago(40) }),
      failedReminder: await job('task.reminder', { status: 'failed', runAt: ago(30), attempts: 5, lastError: 'Mail server down' }), // a failure stays for support to read
      otherOldJob: await job('activity.daily_summary', { status: 'succeeded', runAt: ago(31), completedAt: ago(30) }), // another module's job is none of the tasks' business
    };
    try {
      await repeat.ensureArmed();
      const kept = new Set((await prisma.scheduledJob.findMany({ where: { dedupeKey: { startsWith: 'purge-test:' } }, select: { id: true } })).map((j) => j.id));
      const stillThere = Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, kept.has(row.id)]));
      expect(stillThere).toEqual({
        oldReminder: false,
        oldRepeat: false,
        recentReminder: true,
        recentRepeat: true,
        pendingReminder: true,
        pendingRepeat: true,
        failedReminder: true,
        otherOldJob: true,
      });
    } finally {
      await prisma.scheduledJob.deleteMany({ where: { dedupeKey: { startsWith: 'purge-test:' } } });
    }
  });
});

// ------------------------------------------------------------------------------------------------------- leaver hand-over

describe('leaver hand-over', () => {
  async function leaverWithTasks(name: string, email: string) {
    const leaver = await createEmployee(prisma, { name, officialEmail: email, reportsToEmpId: CTO });
    const own = (over: Record<string, unknown>) => makeTask({ assigneeId: leaver.id, ...over });
    const tasks = {
      moved: await own({ assignedById: ids[DIRECTOR], status: 'in_progress', startedAt: new Date() }),
      onHold: await own({ assignedById: ids[DIRECTOR], status: 'on_hold' }),
      handedIn: await own({ assignedById: ids[DIRECTOR], status: 'submitted' }),
      closed: await own({ assignedById: ids[CTO], status: 'assigned' }),
      keptForReview: await own({ assignedById: ids[CTO], status: 'under_review' }),
      todo: await own({ number: `TODO-${++seq}`, personal: true, assignedById: leaver.id, points: 0, size: 'XS', estimatedHours: 1 }),
      approved: await own({ assignedById: ids[DIRECTOR], status: 'approved', closedAt: new Date() }),
      cancelled: await own({ assignedById: ids[DIRECTOR], status: 'cancelled', closedAt: new Date() }),
      someoneElses: await makeTask({ assigneeId: ids[DEV1], assignedById: ids[CTO] }),
    };
    const series = {
      moves: await prisma.taskRepeatRule.create({ data: ruleData(leaver.id, ids[DIRECTOR], 'Report from the Director') as never }),
      stops: await prisma.taskRepeatRule.create({ data: ruleData(leaver.id, ids[CTO], 'Report from the CTO') as never }),
    };
    return { leaver, tasks, series };
  }
  const ruleData = (assigneeId: string, assignedById: string, title: string) => ({
    every: 'week', on: 1, title, assigneeId, assignedById, priority: 'medium', size: 'S', estimatedHours: 4, startTime: '09:00', durationMinutes: 540, checklist: [], lastOccurrenceOn: dayDate(pkDay()),
  });
  const history = (taskId: string) => prisma.taskHistory.findMany({ where: { taskId }, orderBy: { at: 'asc' } });
  const eventsOf = async (type: string, taskId: string) => (await prisma.outboxEvent.findMany({ where: { type } })).filter((e) => (e.payload as { taskId?: string }).taskId === taskId);

  it('moves the open work tasks and series to the manager, closes what the manager cannot take, and leaves the rest alone', async () => {
    const { leaver, tasks, series } = await leaverWithTasks('Test Leaver', 'test.leaver@acevatech.com');
    await reminders.sync(tasks.moved.id);
    await reminders.sync(tasks.closed.id); // the closed task has pending reminders until the hand-over
    expect((await pendingJobs(tasks.closed.id)).length).toBeGreaterThan(0);
    await prisma.employee.update({ where: { id: leaver.id }, data: { status: 'left' } });
    t.mailer.clear();

    await outbox.emit({ type: 'task.transfer.requested', actor: 'system', payload: { fromEmpId: leaver.empId, toEmpId: CTO, reason: 'employee_left' } });
    await dispatcher.tick();

    const get = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
    // moved: the manager owns it now, one history line, one event
    for (const task of [tasks.moved, tasks.onHold, tasks.handedIn]) {
      const row = await get(task.id);
      expect(row.assigneeId).toBe(ids[CTO]);
      expect(row.status).toBe(task.status); // the status is unchanged
      const lines = await history(task.id);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ kind: 'transferred', fromStatus: task.status, toStatus: task.status, byId: null, reason: 'Employee left', details: { fromEmpId: leaver.empId, toEmpId: CTO } });
      const events = await eventsOf('task.transferred', task.id);
      expect(events).toHaveLength(1);
      expect(events[0].actor).toBe('system');
      expect(events[0].payload).toMatchObject({ fromEmpId: leaver.empId, toEmpId: CTO, reason: 'employee_left', number: task.number });
    }
    // the CTO assigned this one himself: nobody reviews their own task, so it is closed (and stays on the leaver)
    const closed = await get(tasks.closed.id);
    expect(closed).toMatchObject({ status: 'cancelled', assigneeId: leaver.id });
    expect(closed.closedAt).not.toBeNull();
    const closedLines = await history(tasks.closed.id);
    expect(closedLines).toHaveLength(1);
    expect(closedLines[0]).toMatchObject({ kind: 'status', fromStatus: 'assigned', toStatus: 'cancelled', byId: null, reason: 'Closed on hand-over: the assigner takes over' });
    expect((await eventsOf('task.status_changed', tasks.closed.id))[0].payload).toMatchObject({ from: 'assigned', to: 'cancelled', personal: false });
    expect(await pendingJobs(tasks.closed.id)).toEqual([]); // its reminders are gone
    // finished work waiting for its reviewer is not closed
    expect(await get(tasks.keptForReview.id)).toMatchObject({ status: 'under_review', assigneeId: leaver.id });
    expect(await history(tasks.keptForReview.id)).toEqual([]);
    // personal to-do, approved, cancelled and other people's tasks: untouched
    for (const task of [tasks.todo, tasks.approved, tasks.cancelled]) {
      expect((await get(task.id)).assigneeId).toBe(leaver.id);
      expect(await history(task.id)).toEqual([]);
    }
    expect((await get(tasks.someoneElses.id)).assigneeId).toBe(ids[DEV1]);
    // the moved task's reminders are still armed and now belong to the manager
    expect((await pendingJobs(tasks.moved.id)).length).toBeGreaterThan(0);
    // repeating series: the Director's moves to the manager, the CTO's stops
    expect(await prisma.taskRepeatRule.findUniqueOrThrow({ where: { id: series.moves.id } })).toMatchObject({ assigneeId: ids[CTO], active: true });
    expect(await prisma.taskRepeatRule.findUniqueOrThrow({ where: { id: series.stops.id } })).toMatchObject({ assigneeId: leaver.id, active: false });
    // one audit entry with the counts, written by the system
    const audit = await prisma.auditLog.findMany({ where: { action: 'task.handover', targetId: leaver.empId } });
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBeNull();
    expect(audit[0].details).toMatchObject({ toEmpId: CTO, moved: 3, cancelled: 1, repeatRules: 1, repeatRulesStopped: 1 });
    // nobody is mailed on the leaver's behalf (they left)
    expect(t.mailer.sent.filter((m) => m.to === 'test.leaver@acevatech.com')).toHaveLength(0);
    // the manager who took over gets ONE mail: what moved, what was closed and why, what waits for its review
    const summary = t.mailer.sent.filter((m) => m.to === OMAR && m.subject === 'Test Leaver has left: their open tasks');
    expect(summary).toHaveLength(1);
    for (const task of [tasks.moved, tasks.onHold, tasks.handedIn, tasks.closed, tasks.keptForReview]) expect(summary[0].text).toContain(task.number);
    expect(summary[0].text).toContain('the assigner takes over');
    expect(summary[0].text).toContain('Repeating tasks that were stopped: 1');
  });

  it('is idempotent: the same event again, or the service called twice, changes nothing', async () => {
    const { leaver, tasks } = await leaverWithTasks('Second Leaver', 'second.leaver@acevatech.com');
    await prisma.employee.update({ where: { id: leaver.id }, data: { status: 'left' } });
    const first = await handover.transfer(leaver.empId, CTO, 'event-1');
    expect(first).toMatchObject({ moved: 3, cancelled: 1, repeatRules: 1, repeatRulesStopped: 1 });
    const linesBefore = await prisma.taskHistory.count();
    const eventsBefore = await prisma.outboxEvent.count({ where: { type: { in: ['task.transferred', 'task.status_changed'] } } });
    const auditBefore = await prisma.auditLog.count({ where: { action: 'task.handover', targetId: leaver.empId } });

    const again = await handover.transfer(leaver.empId, CTO, 'event-1');
    expect(again).toEqual({ moved: 0, cancelled: 0, repeatRules: 0, repeatRulesStopped: 0 });
    expect(await prisma.taskHistory.count()).toBe(linesBefore);
    expect(await prisma.outboxEvent.count({ where: { type: { in: ['task.transferred', 'task.status_changed'] } } })).toBe(eventsBefore);
    expect(await prisma.auditLog.count({ where: { action: 'task.handover', targetId: leaver.empId } })).toBe(auditBefore);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: tasks.moved.id } })).assigneeId).toBe(ids[CTO]);
  });

  it('delivering the event twice through the outbox moves each task once', async () => {
    const { leaver, tasks } = await leaverWithTasks('Third Leaver', 'third.leaver@acevatech.com');
    await prisma.employee.update({ where: { id: leaver.id }, data: { status: 'left' } });
    await outbox.emit({ type: 'task.transfer.requested', actor: 'system', payload: { fromEmpId: leaver.empId, toEmpId: CTO, reason: 'employee_left' } });
    await outbox.emit({ type: 'task.transfer.requested', actor: 'system', payload: { fromEmpId: leaver.empId, toEmpId: CTO, reason: 'employee_left' } });
    await dispatcher.tick();
    expect(await history(tasks.moved.id)).toHaveLength(1);
    expect(await eventsOf('task.transferred', tasks.moved.id)).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: 'task.handover', targetId: leaver.empId } })).toBe(1);
  });

  it('works through the real leaving flow: the last working day passes, the open tasks go to the manager', async () => {
    const { leaver, tasks } = await leaverWithTasks('Real Leaver', 'real.leaver@acevatech.com');
    const lastDay = addDays(pkDay(), -2);
    await prisma.employee.update({ where: { id: leaver.id }, data: { status: 'on_notice', lastWorkingDay: dayDate(lastDay) } });
    await t.app.get(OffboardingService).process(leaver.empId);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: leaver.id } })).status).toBe('left');
    const request = (await prisma.outboxEvent.findMany({ where: { type: 'task.transfer.requested' } })).filter((e) => (e.payload as { fromEmpId: string }).fromEmpId === leaver.empId);
    expect(request).toHaveLength(1);
    await dispatcher.tick();
    expect((await prisma.task.findUniqueOrThrow({ where: { id: tasks.moved.id } })).assigneeId).toBe(ids[CTO]);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: tasks.closed.id } })).status).toBe('cancelled');
    expect(await prisma.outboxDelivery.count({ where: { eventId: request[0].id, consumer: 'tasks.handover' } })).toBe(1);
  });

  it('never moves work up the line: a new owner who is not below the person who assigned it gets it closed, and the assigner is told', async () => {
    // The CTO's developer leaves after the CTO's own seat went away, so the Director takes over. The Director is ABOVE the CTO:
    // a CTO-assigned task would end up with the CTO's manager, who nobody can review and whom the CTO could still direct.
    const leaver = await createEmployee(prisma, { name: 'Upward Leaver', officialEmail: 'upward.leaver@acevatech.com', reportsToEmpId: CTO });
    const doing = await makeTask({ assigneeId: leaver.id, assignedById: ids[CTO], status: 'in_progress', startedAt: new Date() });
    const waiting = await makeTask({ assigneeId: leaver.id, assignedById: ids[CTO], status: 'submitted' });
    const ownTask = await makeTask({ assigneeId: leaver.id, assignedById: ids[DIRECTOR], status: 'assigned' });
    const series = await prisma.taskRepeatRule.create({ data: ruleData(leaver.id, ids[CTO], 'Weekly from the CTO') as never });
    await prisma.employee.update({ where: { id: leaver.id }, data: { status: 'left' } });
    t.mailer.clear();

    const counts = await handover.transfer(leaver.empId, DIRECTOR, 'event-upward');
    expect(counts).toEqual({ moved: 0, cancelled: 2, repeatRules: 0, repeatRulesStopped: 1 });

    const get = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
    expect(await get(doing.id)).toMatchObject({ status: 'cancelled', assigneeId: leaver.id });
    expect((await history(doing.id))[0]).toMatchObject({ kind: 'status', toStatus: 'cancelled', byId: null, reason: 'Closed on hand-over: the new owner is not below the person who assigned it' });
    expect(await get(waiting.id)).toMatchObject({ status: 'submitted', assigneeId: leaver.id }); // handed in: stays for its review
    expect(await history(waiting.id)).toEqual([]);
    expect(await get(ownTask.id)).toMatchObject({ status: 'cancelled', assigneeId: leaver.id });
    expect((await history(ownTask.id))[0]).toMatchObject({ reason: 'Closed on hand-over: the assigner takes over' });
    expect(await prisma.taskRepeatRule.findUniqueOrThrow({ where: { id: series.id } })).toMatchObject({ active: false, assigneeId: leaver.id });
    expect(await prisma.task.count({ where: { assigneeId: ids[DIRECTOR], assignedById: ids[CTO] } })).toBe(0); // nothing climbed the line

    // the Director who took over hears all of it; the CTO hears about the task he assigned that was closed
    const toDirector = t.mailer.sent.filter((m) => m.to === 'bilal@acevatech.com' && m.subject === 'Upward Leaver has left: their open tasks');
    expect(toDirector).toHaveLength(1);
    for (const task of [doing, waiting, ownTask]) expect(toDirector[0].text).toContain(task.number);
    const toCto = t.mailer.sent.filter((m) => m.to === OMAR && m.subject === 'Tasks you assigned to Upward Leaver were closed');
    expect(toCto).toHaveLength(1);
    expect(toCto[0].text).toContain(doing.number);
    expect(toCto[0].text).not.toContain(ownTask.number);

    // the same call again changes nothing and sends nothing
    t.mailer.clear();
    expect(await handover.transfer(leaver.empId, DIRECTOR, 'event-upward')).toEqual({ moved: 0, cancelled: 0, repeatRules: 0, repeatRulesStopped: 0 });
    expect(t.mailer.sent).toHaveLength(0);
  });

  it('a temporary absence never closes work: the Director is away with the CTO as his stand-in on the last day, and his tasks still move to the CTO', async () => {
    // For the length of the absence the routing finds nobody to review a Director-assigned task for the CTO: the stand-in
    // is the CTO himself (nobody reviews their own task) and the CEO / Founder / Owner never reviews work. The Director
    // reviews it when he is back, so the absence must not close the leaver's tasks for good.
    const leaver = await createEmployee(prisma, { name: 'Absence Leaver', officialEmail: 'absence.leaver@acevatech.com', reportsToEmpId: CTO });
    const doing = await makeTask({ assigneeId: leaver.id, assignedById: ids[DIRECTOR], status: 'in_progress', startedAt: new Date() });
    const notStarted = await makeTask({ assigneeId: leaver.id, assignedById: ids[DIRECTOR], status: 'assigned' });
    const handedIn = await makeTask({ assigneeId: leaver.id, assignedById: ids[DIRECTOR], status: 'submitted' });
    const series = await prisma.taskRepeatRule.create({ data: ruleData(leaver.id, ids[DIRECTOR], 'Weekly from the Director') as never });
    const away = await prisma.standIn.create({ data: { managerId: ids[DIRECTOR], standInId: ids[CTO], startsOn: dayDate(addDays(pkDay(), -1)), endsOn: dayDate(addDays(pkDay(), 2)), reason: 'Away' } });
    try {
      // the situation is real: today's routing has nobody for the CTO's own items
      expect((await t.app.get(ApprovalsService).route(CTO, pkDay())).approver).toBeNull();
      await prisma.employee.update({ where: { id: leaver.id }, data: { status: 'on_notice', lastWorkingDay: dayDate(addDays(pkDay(), -2)) } });
      t.mailer.clear();
      await t.app.get(OffboardingService).process(leaver.empId);
      await dispatcher.tick();

      const get = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
      for (const task of [doing, notStarted, handedIn]) {
        expect(await get(task.id)).toMatchObject({ assigneeId: ids[CTO], status: task.status });
        const lines = await history(task.id);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ kind: 'transferred', reason: 'Employee left', details: { fromEmpId: leaver.empId, toEmpId: CTO } });
      }
      expect(await prisma.taskRepeatRule.findUniqueOrThrow({ where: { id: series.id } })).toMatchObject({ assigneeId: ids[CTO], active: true });
      const audit = await prisma.auditLog.findMany({ where: { action: 'task.handover', targetId: leaver.empId } });
      expect(audit).toHaveLength(1);
      expect(audit[0].details).toMatchObject({ toEmpId: CTO, moved: 3, cancelled: 0, repeatRules: 1, repeatRulesStopped: 0 });
      expect(await prisma.task.count({ where: { assigneeId: leaver.id, status: 'cancelled' } })).toBe(0);
      // the CTO is told what moved, and nothing was closed
      const summary = t.mailer.sent.filter((m) => m.to === OMAR && m.subject === 'Absence Leaver has left: their open tasks');
      expect(summary).toHaveLength(1);
      expect(summary[0].text).not.toContain('nobody could review');

      // while the Director is away nobody can review them; when he is back he does
      const workflow = t.app.get(TaskWorkflowService);
      expect(await workflow.reviewerOf(doing.id)).toBeNull();
      await prisma.standIn.update({ where: { id: away.id }, data: { revokedAt: new Date() } });
      expect(await workflow.reviewerOf(doing.id)).toBe(DIRECTOR);
    } finally {
      await prisma.standIn.update({ where: { id: away.id }, data: { revokedAt: new Date() } });
    }
  });

  it('never moves work to a new owner nobody could ever review: the assigner left and nobody above him holds task.review', async () => {
    // A CTO-level boss who reports straight to the CEO / Founder / Owner assigned the work and then left. His developer
    // takes over the leaver's tasks, but above that developer only the view-only Owner is left, so nobody could ever review.
    const boss = await createEmployee(prisma, { name: 'Gone Boss', roleKey: 'cto', reportsToEmpId: 'ACV-0001' });
    const developer = await createEmployee(prisma, { name: 'Next Developer', reportsToEmpId: boss.empId });
    const leaver = await createEmployee(prisma, { name: 'Unreviewed Leaver', officialEmail: 'unreviewed.leaver@acevatech.com', reportsToEmpId: developer.empId });
    const task = await makeTask({ assigneeId: leaver.id, assignedById: boss.id, status: 'in_progress', startedAt: new Date() });
    const series = await prisma.taskRepeatRule.create({ data: ruleData(leaver.id, boss.id, 'Weekly from the gone boss') as never });
    await prisma.employee.update({ where: { id: boss.id }, data: { status: 'left' } });
    await prisma.employee.update({ where: { id: leaver.id }, data: { status: 'left' } });

    expect(await handover.transfer(leaver.empId, developer.empId, 'event-unreviewed')).toEqual({ moved: 0, cancelled: 1, repeatRules: 0, repeatRulesStopped: 1 });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'cancelled', assigneeId: leaver.id });
    expect((await history(task.id))[0]).toMatchObject({ kind: 'status', toStatus: 'cancelled', byId: null, reason: 'Closed on hand-over: nobody could review it for the new owner' });
    expect(await prisma.taskRepeatRule.findUniqueOrThrow({ where: { id: series.id } })).toMatchObject({ active: false, assigneeId: leaver.id });
  });

  it('does nothing, without failing, for a person who does not exist', async () => {
    expect(await handover.transfer('ACV-9999', CTO, 'event-x')).toEqual({ moved: 0, cancelled: 0, repeatRules: 0, repeatRulesStopped: 0 });
  });
});

// ------------------------------------------------------------------------------------------------------------- the mails

describe('task mails', () => {
  async function comment(taskId: string, authorEmpId: string, body: string, mentions: string[]) {
    const row = await prisma.taskComment.create({ data: { taskId, authorId: ids[authorEmpId], body } });
    for (const empId of mentions) await prisma.taskCommentMention.create({ data: { commentId: row.id, employeeId: ids[empId] } });
    await outbox.emit({ type: 'task.comment_added', actor: authorEmpId, payload: { taskId, number: (await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).number, commentId: row.id, assignee: DEV2, assignedBy: CTO, mentions } });
    return row;
  }

  it('a mention mails the mentioned person with the start of the comment, never the author, and skips people without an address', async () => {
    const task = await makeTask();
    const nobody = await createEmployee(prisma, { name: 'No Address', officialEmail: null, reportsToEmpId: CTO });
    ids[nobody.empId] = nobody.id;
    t.mailer.clear();
    await comment(task.id, DEV2, `@Fahad please look at this ${'x'.repeat(400)}`, [DEV1, DEV2, nobody.empId]); // mentions himself and someone without an address too
    await dispatcher.tick();
    expect(t.mailer.sent).toHaveLength(1);
    const mail = t.mailer.lastTo(FAHAD)!;
    expect(mail.subject).toBe(`Mariam Shah mentioned you on ${task.number}`);
    expect(mail.text).toContain('@Fahad please look at this');
    expect(mail.text).toContain('...'); // cut at 300 characters
    expect(mail.text).not.toContain('x'.repeat(350));
    expect(mail.text).toContain(`/tasks/${task.id}`);
    expect(t.mailer.lastTo(MARIAM)).toBeUndefined();
  });

  it('a comment that mentions nobody sends no mail', async () => {
    const task = await makeTask();
    t.mailer.clear();
    await comment(task.id, DEV2, 'Just a note', []);
    await dispatcher.tick();
    expect(t.mailer.sent).toHaveLength(0);
  });

  it('handed in: the assigner is told; approved: the person hears the rating; rework, hold and cancel: the person hears why', async () => {
    const task = await makeTask();
    t.mailer.clear();
    await setStatus(task.id, 'in_progress', DEV2); // starting is not mailed
    expect(t.mailer.sent).toHaveLength(0);

    await setStatus(task.id, 'submitted', DEV2);
    expect(mailsWith('Waiting for your review', OMAR)).toHaveLength(1);
    expect(t.mailer.sent).toHaveLength(1);

    await prisma.taskReview.create({ data: { taskId: task.id, reviewerId: ids[CTO], decision: 'rework', reason: 'The tests are missing', submittedAt: new Date(), deadlineAtReview: task.deadline } });
    await setStatus(task.id, 'rework', CTO);
    const rework = mailsWith('Sent back for rework', MARIAM);
    expect(rework).toHaveLength(1);
    expect(rework[0].text).toContain('Reason: "The tests are missing"');

    await setStatus(task.id, 'submitted', DEV2);
    await prisma.taskReview.create({ data: { taskId: task.id, reviewerId: ids[CTO], decision: 'approved', rating: 4, comment: 'Good fix', submittedAt: new Date(), deadlineAtReview: task.deadline } });
    await setStatus(task.id, 'approved', CTO);
    const approved = mailsWith('Approved', MARIAM);
    expect(approved).toHaveLength(1);
    expect(approved[0].text).toContain('rating of 4 out of 5');
    expect(approved[0].text).toContain('Comment: "Good fix"');

    const held = await makeTask();
    await setStatus(held.id, 'on_hold', CTO);
    expect(mailsWith('Put on hold', MARIAM)).toHaveLength(1);
    await setStatus(held.id, 'cancelled', CTO);
    expect(mailsWith('Cancelled', MARIAM)).toHaveLength(1);
  });

  it('personal to-dos are never mailed about, and nobody is mailed about their own action', async () => {
    const todo = await makeTask({ number: `TODO-${++seq}`, personal: true, assignedById: ids[DEV2], points: 0, size: 'XS', estimatedHours: 1 });
    t.mailer.clear();
    await setStatus(todo.id, 'approved', DEV2);
    expect(t.mailer.sent).toHaveLength(0);
    const task = await makeTask();
    await setStatus(task.id, 'cancelled', DEV2); // done by the assignee himself (not allowed in real life, but he is never told what he did)
    expect(t.mailer.sent).toHaveLength(0);
  });

  it('extension mails: the request goes to the assigner, the decision to the person who asked', async () => {
    const task = await makeTask();
    const asked = new Date(task.deadline.getTime() + 2 * DAY);
    const ext = await prisma.taskExtension.create({ data: { taskId: task.id, requestedById: ids[DEV2], currentDeadline: task.deadline, requestedDeadline: asked, reason: 'Waiting on the client', late: false } });
    t.mailer.clear();
    await outbox.emit({ type: 'task.extension_requested', actor: DEV2, payload: { taskId: task.id, number: task.number, extensionId: ext.id, assignee: DEV2, assignedBy: CTO, currentDeadline: task.deadline.toISOString(), requestedDeadline: asked.toISOString(), late: false } });
    await dispatcher.tick();
    const request = mailsWith('Extension asked', OMAR);
    expect(request).toHaveLength(1);
    expect(request[0].text).toContain('Waiting on the client');
    expect(t.mailer.sent).toHaveLength(1);

    await prisma.taskExtension.update({ where: { id: ext.id }, data: { status: 'approved', decidedById: ids[CTO], decidedAt: new Date() } });
    await outbox.emit({ type: 'task.extension_decided', actor: CTO, payload: { taskId: task.id, number: task.number, extensionId: ext.id, requestedBy: DEV2, decidedBy: CTO, decision: 'approved', newDeadline: asked.toISOString(), late: false } });
    await dispatcher.tick();
    const decided = mailsWith('Extension approved', MARIAM);
    expect(decided).toHaveLength(1);
    expect(decided[0].text).toContain('New deadline:');

    const second = await makeTask();
    const ext2 = await prisma.taskExtension.create({ data: { taskId: second.id, requestedById: ids[DEV2], currentDeadline: second.deadline, requestedDeadline: new Date(second.deadline.getTime() + DAY), reason: 'More time', late: true } });
    await prisma.taskExtension.update({ where: { id: ext2.id }, data: { status: 'rejected', decidedById: ids[CTO], decidedAt: new Date(), decisionReason: 'The client needs it Friday' } });
    await outbox.emit({ type: 'task.extension_decided', actor: CTO, payload: { taskId: second.id, number: second.number, extensionId: ext2.id, requestedBy: DEV2, decidedBy: CTO, decision: 'rejected', newDeadline: null, late: true } });
    await dispatcher.tick();
    const rejected = mailsWith('Extension not approved', MARIAM);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].text).toContain('Reason: "The client needs it Friday"');
  });

  it('a mail server that is down makes the event retry later, and the mail goes out once it is back', async () => {
    const task = await makeTask();
    t.mailer.clear();
    t.mailer.failing = true;
    await emitStatus(task.id, 'assigned', 'rework', CTO, 'Please redo the report');
    await dispatcher.tick();
    expect(t.mailer.sent).toHaveLength(0);
    const waiting = (await prisma.outboxEvent.findMany({ where: { type: 'task.status_changed', processedAt: null } })).filter((e) => (e.payload as { taskId: string }).taskId === task.id);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].lastError).toContain('tasks.mail');

    t.mailer.failing = false;
    await pass(5 * 60_000); // past the retry delay
    expect(mailsWith('Sent back for rework', MARIAM)).toHaveLength(1);
    expect(await prisma.outboxDelivery.count({ where: { eventId: waiting[0].id, consumer: 'tasks.mail' } })).toBe(1);
  });
});

// --------------------------------------------------------------------------------------- the M4 daily-summary tasks hook

describe('tasks touched in the daily summary', () => {
  it('registers itself as the source of "tasks touched"', () => {
    expect(t.app.get(ActivitySummaryHooks).tasksTouchedSource()).not.toBeNull();
  });

  it('counts the different work tasks a person acted on in the window, from the task tables, one query for everybody', async () => {
    const source = t.app.get(ActivitySummaryHooks).tasksTouchedSource()!;
    // Earlier tests of this file left tasks with lines by the same people in the same hours: count only what this test adds.
    const people = [ids[DEV2], ids[DEV1], ids[CTO], ids[DIRECTOR]];
    const query = { employeeIds: people, day: pkDay(), start: new Date(Date.now() - 2 * HOUR), end: new Date(Date.now() + 2 * HOUR) };
    const base = await source(query);
    const a = await makeTask();
    const b = await makeTask();
    const c = await makeTask();
    const d = await makeTask();
    const e = await makeTask();
    const todo = await makeTask({ number: `TODO-${++seq}`, personal: true, assignedById: ids[DEV2], points: 0, size: 'XS', estimatedHours: 1 });
    const outside = await makeTask();
    const window = { start: new Date(Date.now() - 2 * HOUR), end: new Date(Date.now() + 2 * HOUR) };

    // DEV2 touches A (a history line and a comment: still one task), B (a comment), C (a ticked step), D (an extension request) and a personal to-do
    await prisma.taskHistory.create({ data: { taskId: a.id, kind: 'status', fromStatus: 'assigned', toStatus: 'in_progress', byId: ids[DEV2] } });
    await prisma.taskComment.create({ data: { taskId: a.id, authorId: ids[DEV2], body: 'On it' } });
    await prisma.taskComment.create({ data: { taskId: b.id, authorId: ids[DEV2], body: 'A question' } });
    await prisma.taskChecklistItem.create({ data: { taskId: c.id, position: 0, text: 'Step', done: true, doneAt: new Date(), doneBy: ids[DEV2] } });
    const ext = await prisma.taskExtension.create({ data: { taskId: d.id, requestedById: ids[DEV2], currentDeadline: d.deadline, requestedDeadline: new Date(d.deadline.getTime() + DAY), reason: 'More time' } });
    await prisma.taskHistory.create({ data: { taskId: todo.id, kind: 'status', fromStatus: 'assigned', toStatus: 'in_progress', byId: ids[DEV2] } });
    // outside the window: an old line on another task
    await prisma.taskHistory.create({ data: { taskId: outside.id, kind: 'status', fromStatus: 'assigned', toStatus: 'in_progress', byId: ids[DEV2], at: new Date(Date.now() - 3 * DAY) } });
    // DEV1: a file on E; the system: a line with nobody behind it
    await prisma.taskAttachment.create({ data: { taskId: e.id, uploadedById: ids[DEV1], storageKey: `test-${e.id}`, originalFilename: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) } });
    await prisma.taskHistory.create({ data: { taskId: e.id, kind: 'transferred', fromStatus: 'assigned', toStatus: 'assigned', byId: null } });
    // the CTO decides D's extension and reviews E
    await prisma.taskExtension.update({ where: { id: ext.id }, data: { status: 'approved', decidedById: ids[CTO], decidedAt: new Date() } });
    await prisma.taskReview.create({ data: { taskId: e.id, reviewerId: ids[CTO], decision: 'approved', rating: 5, submittedAt: new Date(), deadlineAtReview: e.deadline } });

    const counts = await source({ ...query, ...window });
    const added = (id: string) => (counts.get(id) ?? 0) - (base.get(id) ?? 0);
    expect(added(ids[DEV2])).toBe(4); // A, B, C, D (not the personal to-do, not the old line)
    expect(added(ids[DEV1])).toBe(1); // E
    expect(added(ids[CTO])).toBe(2); // D (decided) and E (reviewed)
    expect(added(ids[DIRECTOR])).toBe(0);
    expect(await source({ employeeIds: [], day: pkDay(), ...window })).toEqual(new Map());
  });
});
