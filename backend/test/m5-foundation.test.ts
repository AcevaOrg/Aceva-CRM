import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { DEMO_HOLIDAYS, DEMO_PROJECTS, seedTaskReferenceData } from '../prisma/seed-tasks';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma, inRolledBackTransaction } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 5 data layer: what the migration guarantees (the size table, the checks, the insert-only history, the extension
 * rules), the reference seed, and the wiring of the approvals inbox and the task routes. Every write here is rolled back.
 * The behaviour of the endpoints is tested by m5-core.test.ts and m5-automation.test.ts.
 */
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';

let prisma: PrismaClient;
let t: TestApp;
type Tx = Parameters<Parameters<typeof inRolledBackTransaction>[1]>[0];

beforeAll(async () => {
  prisma = createTestPrisma();
  t = await createTestApp();
  await t.signInAll();
});
afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase(); // the logins above left sessions behind
}, 120000);

const idOf = async (tx: Tx, empId: string) => (await tx.employee.findUniqueOrThrow({ where: { empId }, select: { id: true } })).id;
let counter = 9000;
const NOON = new Date('2026-11-16T04:00:00.000Z');
const LATER = new Date('2026-11-19T13:00:00.000Z');

async function newTask(tx: Tx, over: Record<string, unknown> = {}) {
  const assigneeId = await idOf(tx, DEV2);
  const assignedById = await idOf(tx, CTO);
  return tx.task.create({
    data: {
      number: `TSK-${++counter}`,
      title: 'Fix login bug',
      assigneeId,
      assignedById,
      size: 'M',
      points: 3,
      estimatedHours: 16,
      startDate: NOON,
      deadline: LATER,
      originalDeadline: LATER,
      ...over,
    } as never,
  });
}

/** Runs the steps in a transaction that is rolled back; returns the database's error message, or null when nothing failed. */
async function failure(steps: (tx: Tx) => Promise<unknown>): Promise<string | null> {
  try {
    await inRolledBackTransaction(prisma, async (tx) => {
      await steps(tx);
    });
    return null;
  } catch (error) {
    return String((error as Error).message);
  }
}

describe('the size table and the reference data', () => {
  it('the migration inserts the plan table: XS 2 h 1 pt same day, S 4 h 2 pt, M 16 h 3 pt 3 days, L 40 h 5 pt 7 days, XL split first', async () => {
    const rows = await prisma.taskSizeSetting.findMany();
    const order = ['XS', 'S', 'M', 'L', 'XL'];
    const sorted = [...rows].sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size));
    expect(sorted.map((r) => [r.size, Number(r.hours), r.points, r.days])).toEqual([
      ['XS', 2, 1, 0],
      ['S', 4, 2, 1],
      ['M', 16, 3, 3],
      ['L', 40, 5, 7],
      ['XL', 48, 0, null],
    ]);
  });

  it('XL can never get suggested days, and the others always have them', async () => {
    expect(await failure((tx) => tx.taskSizeSetting.update({ where: { size: 'XL' }, data: { days: 5 } }))).toContain('task_size_settings_values');
    expect(await failure((tx) => tx.taskSizeSetting.update({ where: { size: 'M' }, data: { days: null } }))).toContain('task_size_settings_values');
    expect(await failure((tx) => tx.taskSizeSetting.update({ where: { size: 'M' }, data: { hours: 0 } }))).toContain('task_size_settings_values');
  });

  it('seeds the demo projects and the company holidays', async () => {
    expect((await prisma.project.findMany()).map((p) => p.code).sort()).toEqual(DEMO_PROJECTS.map((p) => p.code).sort());
    expect((await prisma.holiday.findMany()).map((h) => h.date.toISOString().slice(0, 10)).sort()).toEqual(DEMO_HOLIDAYS.map((h) => h.date).sort());
  });

  it('one active holiday per date: an archived holiday may share its date with a new one (the same rule as Module 7)', async () => {
    const date = new Date('2026-12-25T00:00:00.000Z'); // a seeded holiday
    expect(await failure((tx) => tx.holiday.create({ data: { date, name: 'Second holiday' } }))).toMatch(/Unique constraint|23505|unique|holidays_active_date/i);
    expect(
      await failure(async (tx) => {
        await tx.holiday.updateMany({ where: { date, archivedAt: null }, data: { archivedAt: NOON } });
        await tx.holiday.create({ data: { date, name: 'Moved holiday' } });
        await tx.holiday.updateMany({ where: { date, archivedAt: null }, data: { archivedAt: LATER } });
        await tx.holiday.create({ data: { date, name: 'Moved again' } });
      }),
    ).toBeNull();
  });

  it('running the reference seed again adds no second holiday on any date', async () => {
    await inRolledBackTransaction(prisma, async (tx) => {
      await seedTaskReferenceData(tx as never);
      const rows = await tx.holiday.findMany({ where: { archivedAt: null } });
      expect(rows.length).toBe(DEMO_HOLIDAYS.length);
    });
  });

  it('task numbers come from two sequences', async () => {
    const a = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT last_value AS n FROM task_number_seq`;
    const b = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT last_value AS n FROM todo_number_seq`;
    expect(Number(a[0].n)).toBeGreaterThanOrEqual(1);
    expect(Number(b[0].n)).toBeGreaterThanOrEqual(1);
  });
});

describe('what a task row must satisfy', () => {
  it('accepts a normal task and a personal to-do', async () => {
    expect(await failure((tx) => newTask(tx))).toBeNull();
    expect(await failure(async (tx) => newTask(tx, { number: 'TODO-0001', personal: true, assigneeId: await idOf(tx, DEV2), assignedById: await idOf(tx, DEV2), points: 0, size: 'XS', estimatedHours: 1 }))).toBeNull();
  });

  it('XL cannot be assigned (it must be split), but a personal to-do may carry any size', async () => {
    expect(await failure((tx) => newTask(tx, { size: 'XL', points: 0 }))).toContain('tasks_xl_not_assignable');
  });

  it('a personal to-do belongs to its maker, and a number says which kind of task it is', async () => {
    expect(await failure((tx) => newTask(tx, { number: 'TODO-0002', personal: true }))).toContain('tasks_personal_own');
    expect(await failure((tx) => newTask(tx, { number: 'TODO-0003' }))).toContain('tasks_number_format');
    expect(await failure((tx) => newTask(tx, { number: 'TSK-1' }))).toContain('tasks_number_format');
  });

  it('a deadline cannot be before the start, hours must be positive, a title is required', async () => {
    expect(await failure((tx) => newTask(tx, { deadline: new Date('2026-11-15T00:00:00Z') }))).toContain('tasks_deadline_not_before_start');
    expect(await failure((tx) => newTask(tx, { estimatedHours: 0 }))).toContain('tasks_numbers');
    expect(await failure((tx) => newTask(tx, { title: '   ' }))).toContain('tasks_title_present');
  });

  it('a task keeps its number, kind, first deadline and points for ever, but the current deadline and status can move', async () => {
    expect(await failure(async (tx) => tx.task.update({ where: { id: (await newTask(tx)).id }, data: { number: 'TSK-0099' } }))).toContain('keeps its number');
    expect(await failure(async (tx) => tx.task.update({ where: { id: (await newTask(tx)).id }, data: { points: 5 } }))).toContain('keeps its number');
    expect(await failure(async (tx) => tx.task.update({ where: { id: (await newTask(tx)).id }, data: { originalDeadline: NOON } }))).toContain('keeps its number');
    expect(await failure(async (tx) => tx.task.update({ where: { id: (await newTask(tx)).id }, data: { deadline: new Date('2026-11-25T13:00:00Z'), status: 'in_progress' } }))).toBeNull();
  });

  it('a task of a repeating series always knows its day, and a day is made once per series', async () => {
    const rule = async (tx: Tx) =>
      tx.taskRepeatRule.create({
        data: { every: 'week', on: 1, title: 'Weekly report', assigneeId: await idOf(tx, DEV2), assignedById: await idOf(tx, CTO), priority: 'medium', size: 'S', estimatedHours: 4, startTime: '09:00', durationMinutes: 540 },
      });
    expect(await failure(async (tx) => newTask(tx, { repeatRuleId: (await rule(tx)).id }))).toContain('tasks_occurrence_with_rule');
    expect(
      await failure(async (tx) => {
        const r = await rule(tx);
        await newTask(tx, { repeatRuleId: r.id, occurrenceOn: new Date('2026-11-16') });
        await newTask(tx, { repeatRuleId: r.id, occurrenceOn: new Date('2026-11-16') });
      }),
    ).toMatch(/Unique constraint|23505|unique/i);
  });

  it('a repeat rule is weekly on 1 to 7 or monthly on 1 to 28, with a valid start time', async () => {
    const make = async (tx: Tx, over: Record<string, unknown>) =>
      tx.taskRepeatRule.create({
        data: { every: 'week', on: 1, title: 'Weekly report', assigneeId: await idOf(tx, DEV2), assignedById: await idOf(tx, CTO), priority: 'medium', size: 'S', estimatedHours: 4, startTime: '09:00', durationMinutes: 540, ...over } as never,
      });
    expect(await failure((tx) => make(tx, { every: 'month', on: 28 }))).toBeNull();
    expect(await failure((tx) => make(tx, { every: 'month', on: 29 }))).toContain('task_repeat_rules_day');
    expect(await failure((tx) => make(tx, { every: 'week', on: 8 }))).toContain('task_repeat_rules_day');
    expect(await failure((tx) => make(tx, { startTime: '25:00' }))).toContain('task_repeat_rules_time');
  });
});

describe('reviews, extensions and history', () => {
  const review = async (tx: Tx, over: Record<string, unknown>) => {
    const task = await newTask(tx);
    return tx.taskReview.create({ data: { taskId: task.id, reviewerId: await idOf(tx, CTO), decision: 'approved', rating: 4, deadlineAtReview: LATER, ...over } as never });
  };

  it('approve needs a rating from 1 to 5; rework needs a reason and no rating', async () => {
    expect(await failure((tx) => review(tx, { rating: 5, comment: 'Great' }))).toBeNull();
    expect(await failure((tx) => review(tx, { rating: null }))).toContain('task_reviews_decision');
    expect(await failure((tx) => review(tx, { rating: 6 }))).toContain('task_reviews_decision');
    expect(await failure((tx) => review(tx, { rating: 0 }))).toContain('task_reviews_decision');
    expect(await failure((tx) => review(tx, { decision: 'rework', rating: null, reason: 'Tests are missing' }))).toBeNull();
    expect(await failure((tx) => review(tx, { decision: 'rework', rating: null, reason: ' ' }))).toContain('task_reviews_decision');
    expect(await failure((tx) => review(tx, { decision: 'rework', rating: 3, reason: 'Tests are missing' }))).toContain('task_reviews_decision');
  });

  it('reviews, history, comments, mentions and size-table changes are insert-only', async () => {
    expect(await failure(async (tx) => tx.taskReview.update({ where: { id: (await review(tx, {})).id }, data: { rating: 5 } }))).toContain('insert-only');
    expect(await failure(async (tx) => tx.taskReview.delete({ where: { id: (await review(tx, {})).id } }))).toContain('insert-only');

    const history = async (tx: Tx) => {
      const task = await newTask(tx);
      return tx.taskHistory.create({ data: { taskId: task.id, kind: 'created', toStatus: 'assigned', byId: await idOf(tx, CTO) } });
    };
    expect(await failure((tx) => history(tx))).toBeNull();
    expect(await failure(async (tx) => tx.taskHistory.update({ where: { id: (await history(tx)).id }, data: { reason: 'edited' } }))).toContain('insert-only');
    expect(await failure(async (tx) => tx.taskHistory.delete({ where: { id: (await history(tx)).id } }))).toContain('insert-only');

    const comment = async (tx: Tx) => {
      const task = await newTask(tx);
      return tx.taskComment.create({ data: { taskId: task.id, authorId: await idOf(tx, CTO), body: 'Thanks @Mariam' } });
    };
    expect(await failure(async (tx) => tx.taskComment.update({ where: { id: (await comment(tx)).id }, data: { body: 'changed' } }))).toContain('insert-only');
    expect(await failure(async (tx) => tx.taskComment.delete({ where: { id: (await comment(tx)).id } }))).toContain('insert-only');
    expect(await failure((tx) => tx.$executeRawUnsafe('TRUNCATE task_comments CASCADE'))).toContain('insert-only');
    expect(
      await failure(async (tx) => {
        const c = await comment(tx);
        await tx.taskCommentMention.create({ data: { commentId: c.id, employeeId: await idOf(tx, DEV2) } });
        await tx.taskCommentMention.deleteMany({ where: { commentId: c.id } });
      }),
    ).toContain('insert-only');

    const change = async (tx: Tx) => tx.taskSizeSettingChange.create({ data: { size: 'M', before: { hours: 16 }, after: { hours: 20 }, reason: 'Our M tasks run longer', changedBy: await idOf(tx, DIRECTOR) } });
    expect(await failure((tx) => change(tx))).toBeNull();
    expect(await failure(async (tx) => tx.taskSizeSettingChange.update({ where: { id: (await change(tx)).id }, data: { reason: 'edited' } }))).toContain('insert-only');
  });

  const extension = async (tx: Tx, over: Record<string, unknown> = {}) => {
    const task = await newTask(tx);
    return tx.taskExtension.create({
      data: { taskId: task.id, requestedById: await idOf(tx, DEV2), currentDeadline: LATER, requestedDeadline: new Date('2026-11-23T13:00:00Z'), reason: 'Waiting for the API keys', ...over } as never,
    });
  };

  it('an extension asks for a later date, has a reason, and one task has one pending request at a time', async () => {
    expect(await failure((tx) => extension(tx))).toBeNull();
    expect(await failure((tx) => extension(tx, { requestedDeadline: LATER }))).toContain('task_extensions_later_deadline');
    expect(await failure((tx) => extension(tx, { reason: ' ' }))).toContain('task_extensions_reason_present');
    expect(
      await failure(async (tx) => {
        const e = await extension(tx);
        await tx.taskExtension.create({ data: { taskId: e.taskId, requestedById: e.requestedById, currentDeadline: LATER, requestedDeadline: new Date('2026-11-24T13:00:00Z'), reason: 'Again' } });
      }),
    ).toMatch(/Unique constraint|23505|unique|one_pending/i);
  });

  it('a pending extension can only be decided, by someone else, and a rejection says why; a decided one never changes', async () => {
    const decide = async (tx: Tx, status: 'approved' | 'rejected', by: string, over: Record<string, unknown> = {}) => {
      const e = await extension(tx);
      return tx.taskExtension.update({ where: { id: e.id }, data: { status, decidedById: await idOf(tx, by), decidedAt: new Date(), ...over } });
    };
    expect(await failure((tx) => decide(tx, 'approved', CTO))).toBeNull();
    expect(await failure((tx) => decide(tx, 'rejected', CTO, { decisionReason: 'Not possible this week' }))).toBeNull();
    expect(await failure((tx) => decide(tx, 'rejected', CTO))).toContain('task_extensions_rejection_reason');
    expect(await failure((tx) => decide(tx, 'approved', DEV2))).toContain('task_extensions_not_own_decision');
    expect(await failure(async (tx) => tx.taskExtension.update({ where: { id: (await extension(tx)).id }, data: { status: 'approved' } }))).toContain('task_extensions_decision');
    // Editing the request itself is refused
    expect(await failure(async (tx) => tx.taskExtension.update({ where: { id: (await extension(tx)).id }, data: { reason: 'something else' } }))).toContain('cannot be edited');
    // Once decided, nothing changes any more
    expect(
      await failure(async (tx) => {
        const e = await extension(tx);
        const done = await tx.taskExtension.update({ where: { id: e.id }, data: { status: 'approved', decidedById: await idOf(tx, CTO), decidedAt: new Date() } });
        await tx.taskExtension.update({ where: { id: done.id }, data: { decisionReason: 'changed my mind' } });
      }),
    ).toContain('cannot be changed');
    expect(
      await failure(async (tx) => {
        const e = await extension(tx);
        await tx.taskExtension.delete({ where: { id: e.id } });
      }),
    ).toContain('never deleted');
  });
});

describe('the approvals inbox and the task routes are wired in', () => {
  it('every task route needs a login', async () => {
    const anon = t.anonymous();
    await anon.get('/api/v1/tasks').expect(401);
    await anon.get('/api/v1/tasks/workload').expect(401);
    await anon.get('/api/v1/projects').expect(401);
    await anon.get('/api/v1/holidays').expect(401);
    await anon.get('/api/v1/settings/task-sizes').expect(401);
    await anon.get('/api/v1/approvals').expect(401);
    await anon.post('/api/v1/tasks').send({}).expect(401);
  });

  it('the approvals inbox answers for a logged-in person (the tasks provider is registered; a module that fails never empties it)', async () => {
    const res = await t.as(DIRECTOR).get('/api/v1/approvals').expect(200);
    expect(res.body).toMatchObject({ routedUp: expect.any(Number) });
    expect(Array.isArray(res.body.items)).toBe(true);
    await t.as(DIRECTOR).get('/api/v1/approvals/oversight').expect(200);
  });

  it('an item that no module owns is not found, and a malformed id is refused', async () => {
    await t.as(DIRECTOR).post('/api/v1/approvals/unknown_kind:123/approve').send({}).expect(404);
    await t.as(DIRECTOR).post('/api/v1/approvals/nonsense/approve').send({}).expect(400);
  });

  it('only people who may settings.manage can change the size table (the Director yes, the CTO and developers no)', async () => {
    await t.as(DEV1).patch('/api/v1/settings/task-sizes/M').send({ hours: 20, reason: 'Our M tasks run longer' }).expect(403);
    await t.as(CTO).patch('/api/v1/settings/task-sizes/M').send({ hours: 20, reason: 'Our M tasks run longer' }).expect(403);
  });

  it('a request that breaks the contract is refused before it reaches the service', async () => {
    await t.as(CTO).post('/api/v1/tasks').send({ title: 'x' }).expect(400);
    await t.as(CTO).post('/api/v1/tasks/7d3f1c9a-2b4e-4a6d-8c1f-0e5a9b7c3d21/approve').send({ rating: 9 }).expect(400);
    await t.as(CTO).post('/api/v1/tasks/7d3f1c9a-2b4e-4a6d-8c1f-0e5a9b7c3d21/rework').send({}).expect(400);
  });
});
