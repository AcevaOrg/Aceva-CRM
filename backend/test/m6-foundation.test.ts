import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma, inRolledBackTransaction } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 6 data layer: what the migration guarantees (the starting weights, whole percents adding up to 100, the insert-only
 * tables, THE RULE THAT SCORECARD NUMBERS NEVER CHANGE except by the recompute after a dispute decision, the dispute rules) and
 * the wiring of the routes. Every write here is rolled back. The behaviour of the endpoints is tested by m6-core.test.ts and
 * m6-automation.test.ts.
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
const standardWeightsId = async (tx: Tx) => (await tx.scoreWeightVersion.findFirstOrThrow({ where: { kind: 'standard', departmentId: null }, orderBy: { versionNo: 'asc' } })).id;
let counter = 7000;
const DEADLINE = new Date('2026-10-20T13:00:00.000Z');

/** A standard scorecard for DEV2 for October 2026, made by the CTO as reviewer. */
async function newCard(tx: Tx, over: Record<string, unknown> = {}) {
  return tx.scorecard.create({
    data: {
      employeeId: await idOf(tx, DEV2),
      month: '2026-10',
      kind: 'standard',
      weightsVersionId: await standardWeightsId(tx),
      metrics: { quality: 81.4, onTime: 80, completion: 100, rework: 20, attendance: null, workloadHours: 12 },
      unmeasured: [{ key: 'attendance', reason: 'attendance_not_available' }],
      score: 85,
      band: 'excellent',
      taskCount: 5,
      smallSample: false,
      reviewerId: await idOf(tx, CTO),
      ...over,
    } as never,
  });
}

/** A rated task of DEV2 and its snapshot row on the scorecard. */
async function newSnapshot(tx: Tx, scorecardId: string, over: Record<string, unknown> = {}) {
  const task = await tx.task.create({
    data: {
      number: `TSK-${++counter}`,
      title: 'Fix login bug',
      assigneeId: await idOf(tx, DEV2),
      assignedById: await idOf(tx, CTO),
      size: 'M',
      points: 3,
      estimatedHours: 16,
      startDate: new Date('2026-10-12T04:00:00Z'),
      deadline: DEADLINE,
      originalDeadline: DEADLINE,
      status: 'approved',
    } as never,
  });
  return tx.scorecardTask.create({
    data: { scorecardId, taskId: task.id, position: 0, number: task.number, title: task.title, size: 'M', points: 3, rating: 3, onTime: true, reworked: false, extensions: 0, status: 'approved', counted: true, deadline: DEADLINE, ...over } as never,
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

describe('the score weights', () => {
  it('the migration inserts the starting versions: standard 35/25/20/10/10 and sales 20/25/30/10/15, company-wide, version 1', async () => {
    const rows = await prisma.scoreWeightVersion.findMany({ orderBy: { kind: 'asc' } });
    expect(rows.map((r) => [r.kind, r.departmentId, r.versionNo, r.createdById])).toEqual([
      ['standard', null, 1, null],
      ['sales', null, 1, null],
    ]);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.weights]));
    expect(byKind.standard).toEqual({ quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10 });
    expect(byKind.sales).toEqual({ activity: 20, meetings: 25, won: 30, dataQuality: 10, attendance: 15 });
  });

  const addVersion = (tx: Tx, over: Record<string, unknown>) => tx.scoreWeightVersion.create({ data: { kind: 'standard', versionNo: 2, weights: { quality: 40, onTime: 20, completion: 20, rework: 10, attendance: 10 }, ...over } as never });

  it('a new version needs whole percents that add up to exactly 100 and the metrics of its kind', async () => {
    expect(await failure((tx) => addVersion(tx, {}))).toBeNull();
    expect(await failure((tx) => addVersion(tx, { weights: { quality: 40, onTime: 20, completion: 20, rework: 10, attendance: 9 } }))).toContain('score_weight_versions_weights');
    expect(await failure((tx) => addVersion(tx, { weights: { quality: 40, onTime: 20, completion: 20, rework: 10, attendance: 11 } }))).toContain('score_weight_versions_weights');
    expect(await failure((tx) => addVersion(tx, { weights: { quality: 40.5, onTime: 19.5, completion: 20, rework: 10, attendance: 10 } }))).toContain('score_weight_versions_weights');
    expect(await failure((tx) => addVersion(tx, { weights: { quality: 110, onTime: -10, completion: 0, rework: 0, attendance: 0 } }))).toContain('score_weight_versions_weights');
    // the sales metrics under the standard kind, a missing metric and an extra metric
    expect(await failure((tx) => addVersion(tx, { weights: { activity: 20, meetings: 25, won: 30, dataQuality: 10, attendance: 15 } }))).toContain('score_weight_versions_weights');
    expect(await failure((tx) => addVersion(tx, { weights: { quality: 50, onTime: 25, completion: 25 } }))).toContain('score_weight_versions_weights');
    expect(await failure((tx) => addVersion(tx, { weights: { quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10, bonus: 0 } }))).toContain('score_weight_versions_weights');
    // a weight of 0 is fine; the sales kind takes the sales metrics
    expect(await failure((tx) => addVersion(tx, { weights: { quality: 50, onTime: 30, completion: 20, rework: 0, attendance: 0 } }))).toBeNull();
    expect(await failure((tx) => addVersion(tx, { kind: 'sales', weights: { activity: 25, meetings: 25, won: 25, dataQuality: 15, attendance: 10 } }))).toBeNull();
  });

  it('every version of a kind and department has its own number', async () => {
    expect(await failure((tx) => addVersion(tx, { versionNo: 1 }))).toMatch(/unique|23505|company_version/i);
    expect(
      await failure(async (tx) => {
        await addVersion(tx, {});
        await addVersion(tx, {});
      }),
    ).toMatch(/unique|23505|company_version/i);
    // a department's own set counts from 1 again, and its number is unique within the department
    expect(
      await failure(async (tx) => {
        const dep = await tx.department.findFirstOrThrow();
        await addVersion(tx, { departmentId: dep.id, versionNo: 1 });
        await addVersion(tx, { departmentId: dep.id, versionNo: 2 });
      }),
    ).toBeNull();
    expect(
      await failure(async (tx) => {
        const dep = await tx.department.findFirstOrThrow();
        await addVersion(tx, { departmentId: dep.id, versionNo: 1 });
        await addVersion(tx, { departmentId: dep.id, versionNo: 1 });
      }),
    ).toMatch(/unique|23505|department_version/i);
  });

  it('versions are insert-only: never edited, never deleted', async () => {
    expect(await failure((tx) => tx.scoreWeightVersion.updateMany({ data: { note: 'changed' } }))).toContain('insert-only');
    expect(await failure((tx) => tx.scoreWeightVersion.deleteMany({}))).toContain('insert-only');
  });
});

describe('what a scorecard row must satisfy', () => {
  it('a scorecard is unique per person and month', async () => {
    expect(await failure((tx) => newCard(tx))).toBeNull();
    expect(
      await failure(async (tx) => {
        await newCard(tx);
        await newCard(tx);
      }),
    ).toMatch(/unique|23505|employee_id_month/i);
    expect(
      await failure(async (tx) => {
        await newCard(tx);
        await newCard(tx, { month: '2026-09' });
      }),
    ).toBeNull();
  });

  it('the month is a real month, the score 0 to 100, and the band always matches the score (85 / 70 / 50)', async () => {
    expect(await failure((tx) => newCard(tx, { month: '2026-13' }))).toContain('scorecards_month_format');
    expect(await failure((tx) => newCard(tx, { month: '2026-1' }))).toContain('scorecards_month_format');
    expect(await failure((tx) => newCard(tx, { score: 100.5, band: 'excellent' }))).toContain('scorecards_');
    for (const [score, band] of [[85, 'excellent'], [84.9, 'good'], [70, 'good'], [69.9, 'needs_improvement'], [50, 'needs_improvement'], [49.9, 'poor'], [0, 'poor']] as const) {
      expect(await failure((tx) => newCard(tx, { score, band }))).toBeNull();
    }
    expect(await failure((tx) => newCard(tx, { score: 84.9, band: 'excellent' }))).toContain('scorecards_band_matches_score');
    expect(await failure((tx) => newCard(tx, { score: 50, band: 'poor' }))).toContain('scorecards_band_matches_score');
    expect(await failure((tx) => newCard(tx, { score: 90, band: null }))).toContain('scorecards_band_matches_score');
    expect(await failure((tx) => newCard(tx, { score: null, band: 'good' }))).toContain('scorecards_band_matches_score');
  });

  it('a scorecard with nothing measured has no score and no band (nothing is made up)', async () => {
    expect(await failure((tx) => newCard(tx, { score: null, band: null, metrics: { quality: null, onTime: null, completion: null, rework: null, attendance: null, workloadHours: 0 }, taskCount: 0, smallSample: true }))).toBeNull();
  });

  it('nobody reviews or releases their own scorecard; only a scorecard without a reviewer is released by the system', async () => {
    expect(await failure(async (tx) => newCard(tx, { reviewerId: await idOf(tx, DEV2) }))).toContain('scorecards_not_own_review');
    expect(await failure(async (tx) => newCard(tx, { status: 'released', releasedAt: new Date(), releasedById: await idOf(tx, DEV2) }))).toContain('scorecards_not_own_review');
    // the Director's scorecard has no reviewer: released at once by the system
    expect(await failure(async (tx) => newCard(tx, { employeeId: await idOf(tx, DIRECTOR), reviewerId: null, status: 'released', releasedAt: new Date() }))).toBeNull();
    // a scorecard that HAS a reviewer is released by a person, never by the system
    expect(await failure((tx) => newCard(tx, { status: 'released', releasedAt: new Date(), releasedById: null }))).toContain('scorecards_system_release');
    expect(await failure(async (tx) => newCard(tx, { status: 'released', releasedAt: new Date(), releasedById: await idOf(tx, CTO) }))).toBeNull();
  });

  it('the status always agrees with the release and acknowledgement dates', async () => {
    expect(await failure(async (tx) => newCard(tx, { status: 'released', releasedById: await idOf(tx, CTO) }))).toContain('scorecards_status_dates');
    expect(await failure(async (tx) => newCard(tx, { releasedAt: new Date(), releasedById: await idOf(tx, CTO) }))).toContain('scorecards_status_dates');
    expect(await failure(async (tx) => newCard(tx, { status: 'acknowledged', releasedAt: new Date(), releasedById: await idOf(tx, CTO) }))).toContain('scorecards_status_dates');
  });
});

describe('THE NUMBERS NEVER CHANGE (the scorecards_protect trigger)', () => {
  it('release and acknowledge move the status forward, and only forward', async () => {
    expect(
      await failure(async (tx) => {
        const c = await newCard(tx);
        const reviewer = await idOf(tx, CTO);
        const released = await tx.scorecard.update({ where: { id: c.id }, data: { status: 'released', releasedAt: new Date(), releasedById: reviewer } });
        await tx.scorecard.update({ where: { id: released.id }, data: { status: 'acknowledged', acknowledgedAt: new Date() } });
      }),
    ).toBeNull();
    expect(
      await failure(async (tx) => {
        const c = await newCard(tx);
        await tx.scorecard.update({ where: { id: c.id }, data: { status: 'acknowledged', releasedAt: new Date(), acknowledgedAt: new Date(), releasedById: await idOf(tx, CTO) } });
      }),
    ).toContain('moves from draft to released to acknowledged');
    expect(
      await failure(async (tx) => {
        const c = await newCard(tx, { status: 'released', releasedAt: new Date(), releasedById: await idOf(tx, CTO) });
        await tx.scorecard.update({ where: { id: c.id }, data: { status: 'draft', releasedAt: null, releasedById: null } });
      }),
    ).toContain('moves from draft to released to acknowledged');
  });

  it('the release and the acknowledgement are set once and never change', async () => {
    expect(
      await failure(async (tx) => {
        const c = await newCard(tx, { status: 'released', releasedAt: DEADLINE, releasedById: await idOf(tx, CTO) });
        await tx.scorecard.update({ where: { id: c.id }, data: { releasedAt: new Date() } });
      }),
    ).toContain('release of a scorecard cannot be changed');
    expect(
      await failure(async (tx) => {
        const c = await newCard(tx, { status: 'released', releasedAt: DEADLINE, releasedById: await idOf(tx, CTO) });
        await tx.scorecard.update({ where: { id: c.id }, data: { releasedById: await idOf(tx, DIRECTOR) } });
      }),
    ).toContain('release of a scorecard cannot be changed');
    expect(
      await failure(async (tx) => {
        const c = await newCard(tx, { status: 'acknowledged', releasedAt: DEADLINE, acknowledgedAt: DEADLINE, releasedById: await idOf(tx, CTO) });
        await tx.scorecard.update({ where: { id: c.id }, data: { acknowledgedAt: new Date() } });
      }),
    ).toContain('acknowledgement of a scorecard cannot be changed');
  });

  it('metrics, score and band cannot be edited: not by the reviewer, not by anyone', async () => {
    for (const data of [
      { metrics: { quality: 100, onTime: 100, completion: 100, rework: 0, attendance: null, workloadHours: 12 } },
      { score: 99, band: 'excellent' },
      { band: 'good' },
      { score: 70, band: 'good' },
    ]) {
      expect(await failure(async (tx) => tx.scorecard.update({ where: { id: (await newCard(tx)).id }, data: data as never }))).toContain('numbers of a scorecard cannot be changed');
    }
  });

  it('the person, month, kind, weights version, task count, sales figures, unmeasured list and reviewer are frozen too', async () => {
    for (const data of [{ month: '2026-09' }, { kind: 'sales' }, { taskCount: 9 }, { smallSample: true }, { salesDetail: { workingDays: 20 } }, { unmeasured: [] }]) {
      expect(await failure(async (tx) => tx.scorecard.update({ where: { id: (await newCard(tx)).id }, data: data as never }))).toContain('scorecard keeps its person');
    }
    expect(await failure(async (tx) => tx.scorecard.update({ where: { id: (await newCard(tx)).id }, data: { employeeId: await idOf(tx, DEV1) } }))).toContain('scorecard keeps its person');
    expect(await failure(async (tx) => tx.scorecard.update({ where: { id: (await newCard(tx)).id }, data: { reviewerId: await idOf(tx, DIRECTOR) } }))).toContain('scorecard keeps its person');
    expect(
      await failure(async (tx) => {
        const other = await tx.scoreWeightVersion.create({ data: { kind: 'standard', versionNo: 2, weights: { quality: 40, onTime: 20, completion: 20, rework: 10, attendance: 10 } } as never });
        await tx.scorecard.update({ where: { id: (await newCard(tx)).id }, data: { weightsVersionId: other.id } });
      }),
    ).toContain('scorecard keeps its person');
  });

  it('a scorecard is never deleted', async () => {
    expect(await failure(async (tx) => tx.scorecard.delete({ where: { id: (await newCard(tx)).id } }))).toContain('never deleted');
  });

  it('the recompute counter cannot be moved without a decided "changed" dispute, and the numbers cannot move without the counter', async () => {
    // numbers and counter together, but no dispute that changed a rating
    expect(
      await failure(async (tx) =>
        tx.scorecard.update({ where: { id: (await newCard(tx)).id }, data: { metrics: { quality: 90, onTime: 80, completion: 100, rework: 20, attendance: null, workloadHours: 12 }, score: 88, band: 'excellent', recomputeCount: { increment: 1 } } }),
      ),
    ).toContain('recomputed only after a dispute decision');
    // the counter alone
    expect(await failure(async (tx) => tx.scorecard.update({ where: { id: (await newCard(tx)).id }, data: { recomputeCount: { increment: 1 } } }))).toContain('recomputed only after a dispute decision');
  });

  /** A released scorecard with one rated task and a dispute on it. */
  async function disputed(tx: Tx) {
    const c = await newCard(tx, { status: 'released', releasedAt: DEADLINE, releasedById: await idOf(tx, CTO) });
    const snap = await newSnapshot(tx, c.id);
    const dispute = await tx.ratingDispute.create({ data: { scorecardId: c.id, taskId: snap.taskId, employeeId: await idOf(tx, DEV2), reason: 'The client changed the brief twice.', ratingAtRaise: 3, deciderId: await idOf(tx, DIRECTOR) } });
    return { c, snap, dispute };
  }
  const NEW_NUMBERS = { metrics: { quality: 90, onTime: 80, completion: 100, rework: 20, attendance: null, workloadHours: 12 }, score: 88, band: 'excellent' } as const;
  /** What newCard stores: the numbers before any dispute. */
  const OLD_NUMBERS = { metrics: { quality: 81.4, onTime: 80, completion: 100, rework: 20, attendance: null, workloadHours: 12 }, score: 85, band: 'excellent' } as const;
  /** A decision that changed the rating records the result it came to (score_after, metrics_after): the one the scorecard must take. */
  const decideChanged = async (tx: Tx, id: string, result: { metrics: Record<string, number | null>; score: number } = NEW_NUMBERS) =>
    tx.ratingDispute.update({
      where: { id },
      data: {
        status: 'changed',
        decidedById: await idOf(tx, DIRECTOR),
        decision: 'Fair point, the brief did change.',
        newRating: 5,
        decidedAt: new Date(),
        scoreBefore: OLD_NUMBERS.score,
        scoreAfter: result.score,
        metricsBefore: OLD_NUMBERS.metrics,
        metricsAfter: result.metrics,
      } as never,
    });

  it('THE ONE EXCEPTION: after a dispute decision that changed a rating, the numbers may change together with the counter, once per decision', async () => {
    expect(
      await failure(async (tx) => {
        const { c, dispute } = await disputed(tx);
        await decideChanged(tx, dispute.id); // the decided dispute comes FIRST
        const after = await tx.scorecard.update({ where: { id: c.id }, data: { ...NEW_NUMBERS, recomputeCount: { increment: 1 } } });
        expect(after.recomputeCount).toBe(1);
        expect(Number(after.score)).toBe(88);
      }),
    ).toBeNull();
    // the recompute with the SAME numbers (a rating change that moves nothing: the decision recorded the old numbers as its result) is still counted
    expect(
      await failure(async (tx) => {
        const { c, dispute } = await disputed(tx);
        await decideChanged(tx, dispute.id, OLD_NUMBERS);
        await tx.scorecard.update({ where: { id: c.id }, data: { recomputeCount: { increment: 1 } } });
      }),
    ).toBeNull();
  });

  it('the new numbers must be the result the decision recorded: other numbers, a counter without the recorded numbers and a different score are refused', async () => {
    const refused = 'must be the result a dispute decision recorded';
    // the decision said 88, somebody writes 91
    expect(
      await failure(async (tx) => {
        const { c, dispute } = await disputed(tx);
        await decideChanged(tx, dispute.id);
        await tx.scorecard.update({ where: { id: c.id }, data: { metrics: NEW_NUMBERS.metrics, score: 91, band: 'excellent', recomputeCount: { increment: 1 } } });
      }),
    ).toContain(refused);
    // the score is the recorded one but the metrics are not
    expect(
      await failure(async (tx) => {
        const { c, dispute } = await disputed(tx);
        await decideChanged(tx, dispute.id);
        await tx.scorecard.update({ where: { id: c.id }, data: { metrics: { ...NEW_NUMBERS.metrics, quality: 100 }, score: 88, band: 'excellent', recomputeCount: { increment: 1 } } });
      }),
    ).toContain(refused);
    // the counter alone, while the decision recorded different numbers (88): the numbers would stay at 85
    expect(
      await failure(async (tx) => {
        const { c, dispute } = await disputed(tx);
        await decideChanged(tx, dispute.id);
        await tx.scorecard.update({ where: { id: c.id }, data: { recomputeCount: { increment: 1 } } });
      }),
    ).toContain(refused);
    // a decision that recorded no result at all (an old row, or written by hand) cannot be applied to any numbers
    expect(
      await failure(async (tx) => {
        const { c, dispute } = await disputed(tx);
        await tx.ratingDispute.update({ where: { id: dispute.id }, data: { status: 'changed', decidedById: await idOf(tx, DIRECTOR), decision: 'Fair point.', newRating: 5, decidedAt: new Date() } });
        await tx.scorecard.update({ where: { id: c.id }, data: { ...NEW_NUMBERS, recomputeCount: { increment: 1 } } });
      }),
    ).toContain(refused);
  });

  it('a dispute that only upheld the rating, or is still open, allows no recompute', async () => {
    expect(
      await failure(async (tx) => {
        const { c } = await disputed(tx);
        await tx.scorecard.update({ where: { id: c.id }, data: { ...NEW_NUMBERS, recomputeCount: { increment: 1 } } });
      }),
    ).toContain('recomputed only after a dispute decision');
    expect(
      await failure(async (tx) => {
        const { c, dispute } = await disputed(tx);
        await tx.ratingDispute.update({ where: { id: dispute.id }, data: { status: 'upheld', decidedById: await idOf(tx, DIRECTOR), decision: 'Rating kept.', decidedAt: new Date() } });
        await tx.scorecard.update({ where: { id: c.id }, data: { ...NEW_NUMBERS, recomputeCount: { increment: 1 } } });
      }),
    ).toContain('recomputed only after a dispute decision');
  });

  it('one decision is applied once: a second recompute needs a second changed dispute; the counter never jumps by 2 or goes back', async () => {
    expect(
      await failure(async (tx) => {
        const { c, dispute } = await disputed(tx);
        await decideChanged(tx, dispute.id);
        await tx.scorecard.update({ where: { id: c.id }, data: { ...NEW_NUMBERS, recomputeCount: { increment: 1 } } });
        await tx.scorecard.update({ where: { id: c.id }, data: { score: 91, band: 'excellent', recomputeCount: { increment: 1 } } });
      }),
    ).toContain('recomputed only after a dispute decision');
    expect(
      await failure(async (tx) => {
        const { c, dispute } = await disputed(tx);
        await decideChanged(tx, dispute.id);
        await tx.scorecard.update({ where: { id: c.id }, data: { recomputeCount: { increment: 2 } } });
      }),
    ).toContain('recomputed only after a dispute decision');
    expect(
      await failure(async (tx) => {
        const { c, dispute } = await disputed(tx);
        await decideChanged(tx, dispute.id);
        await tx.scorecard.update({ where: { id: c.id }, data: { ...NEW_NUMBERS, recomputeCount: { increment: 1 } } });
        await tx.scorecard.update({ where: { id: c.id }, data: { recomputeCount: 0 } });
      }),
    ).toContain('recomputed only after a dispute decision');
  });

  it('the recompute changes only the numbers: everything else stays frozen even then', async () => {
    expect(
      await failure(async (tx) => {
        const { c, dispute } = await disputed(tx);
        await decideChanged(tx, dispute.id);
        await tx.scorecard.update({ where: { id: c.id }, data: { ...NEW_NUMBERS, taskCount: 99, recomputeCount: { increment: 1 } } });
      }),
    ).toContain('scorecard keeps its person');
  });
});

describe('the lists a scorecard keeps are insert-only', () => {
  it('the tasks it was made from never change (a dispute does not edit them) and are never deleted', async () => {
    expect(await failure(async (tx) => tx.scorecardTask.update({ where: { id: (await newSnapshot(tx, (await newCard(tx)).id)).id }, data: { rating: 5 } }))).toContain('insert-only');
    expect(await failure(async (tx) => tx.scorecardTask.delete({ where: { id: (await newSnapshot(tx, (await newCard(tx)).id)).id } }))).toContain('insert-only');
  });

  it('a task appears once per scorecard, with a real rating, points and status', async () => {
    expect(
      await failure(async (tx) => {
        const c = await newCard(tx);
        const s = await newSnapshot(tx, c.id);
        await tx.scorecardTask.create({ data: { scorecardId: c.id, taskId: s.taskId, position: 1, number: s.number, title: 'again', size: 'M', points: 3, rating: 3, onTime: true, reworked: false, extensions: 0, status: 'approved', counted: true, deadline: DEADLINE } });
      }),
    ).toMatch(/unique|23505|scorecard_id_task_id/i);
    expect(await failure(async (tx) => newSnapshot(tx, (await newCard(tx)).id, { rating: 6 }))).toContain('scorecard_tasks_values');
    expect(await failure(async (tx) => newSnapshot(tx, (await newCard(tx)).id, { rating: null, status: 'open' }))).toBeNull();
  });

  it('remarks and comments are kept for ever: several are allowed, none can be edited or deleted', async () => {
    const remark = async (tx: Tx, scorecardId: string, kind: 'reviewer_remark' | 'employee_comment', body = 'Steady month.') =>
      tx.scorecardComment.create({ data: { scorecardId, kind, authorId: await idOf(tx, kind === 'reviewer_remark' ? CTO : DEV2), body } });
    expect(
      await failure(async (tx) => {
        const c = await newCard(tx);
        await remark(tx, c.id, 'reviewer_remark');
        await remark(tx, c.id, 'reviewer_remark', 'Please raise blockers earlier.');
        await remark(tx, c.id, 'employee_comment', 'Thanks.');
      }),
    ).toBeNull();
    expect(await failure(async (tx) => remark(tx, (await newCard(tx)).id, 'reviewer_remark', '  '))).toContain('scorecard_comments_body');
    expect(await failure(async (tx) => tx.scorecardComment.update({ where: { id: (await remark(tx, (await newCard(tx)).id, 'reviewer_remark')).id }, data: { body: 'edited' } }))).toContain('insert-only');
    expect(await failure(async (tx) => tx.scorecardComment.delete({ where: { id: (await remark(tx, (await newCard(tx)).id, 'reviewer_remark')).id } }))).toContain('insert-only');
  });
});

describe('rating disputes', () => {
  async function released(tx: Tx) {
    const c = await newCard(tx, { status: 'released', releasedAt: DEADLINE, releasedById: await idOf(tx, CTO) });
    return { c, snap: await newSnapshot(tx, c.id) };
  }
  const raise = async (tx: Tx, scorecardId: string, taskId: string, over: Record<string, unknown> = {}) =>
    tx.ratingDispute.create({ data: { scorecardId, taskId, employeeId: await idOf(tx, DEV2), reason: 'The client changed the brief twice.', ratingAtRaise: 3, deciderId: await idOf(tx, DIRECTOR), ...over } as never });

  it('the employee disputes a rated task of their own RELEASED scorecard', async () => {
    expect(
      await failure(async (tx) => {
        const { c, snap } = await released(tx);
        const d = await raise(tx, c.id, snap.taskId);
        expect(d.status).toBe('open');
      }),
    ).toBeNull();
  });

  it('not on a draft, not for somebody else, not for a task that is not on the scorecard', async () => {
    expect(
      await failure(async (tx) => {
        const c = await newCard(tx); // draft
        await raise(tx, c.id, (await newSnapshot(tx, c.id)).taskId);
      }),
    ).toContain('only be disputed after the scorecard is released');
    expect(
      await failure(async (tx) => {
        const { c, snap } = await released(tx);
        await raise(tx, c.id, snap.taskId, { employeeId: await idOf(tx, DEV1) });
      }),
    ).toContain('only be disputed by the person the scorecard is about');
    expect(
      await failure(async (tx) => {
        const { c } = await released(tx);
        const other = await tx.task.create({
          data: { number: `TSK-${++counter}`, title: 'Other', assigneeId: await idOf(tx, DEV2), assignedById: await idOf(tx, CTO), size: 'S', points: 2, estimatedHours: 4, startDate: DEADLINE, deadline: DEADLINE, originalDeadline: DEADLINE } as never,
        });
        await raise(tx, c.id, other.id);
      }),
    ).toMatch(/foreign key|23503|scorecard_task/i);
  });

  it('one OPEN dispute per task; after it is decided the task can be disputed again', async () => {
    expect(
      await failure(async (tx) => {
        const { c, snap } = await released(tx);
        await raise(tx, c.id, snap.taskId);
        await raise(tx, c.id, snap.taskId);
      }),
    ).toMatch(/unique|23505|one_open_per_task/i);
    expect(
      await failure(async (tx) => {
        const { c, snap } = await released(tx);
        const d = await raise(tx, c.id, snap.taskId);
        await tx.ratingDispute.update({ where: { id: d.id }, data: { status: 'upheld', decidedById: await idOf(tx, DIRECTOR), decision: 'Rating kept.', decidedAt: new Date() } });
        await raise(tx, c.id, snap.taskId);
      }),
    ).toBeNull();
  });

  it('the decider is never the employee, the reason is required and the rating is 1 to 5', async () => {
    expect(await failure(async (tx) => { const { c, snap } = await released(tx); await raise(tx, c.id, snap.taskId, { deciderId: await idOf(tx, DEV2) }); })).toContain('rating_disputes_values');
    expect(await failure(async (tx) => { const { c, snap } = await released(tx); await raise(tx, c.id, snap.taskId, { reason: '  ' }); })).toContain('rating_disputes_values');
    expect(await failure(async (tx) => { const { c, snap } = await released(tx); await raise(tx, c.id, snap.taskId, { ratingAtRaise: 6 }); })).toContain('rating_disputes_values');
    expect(await failure(async (tx) => { const { c, snap } = await released(tx); await raise(tx, c.id, snap.taskId, { status: 'upheld' }); })).toContain('A new dispute starts open');
  });

  it('a decision says who and why; a changed rating is another rating from 1 to 5; nobody decides their own dispute', async () => {
    const decide = async (tx: Tx, data: Record<string, unknown>) => {
      const { c, snap } = await released(tx);
      const d = await raise(tx, c.id, snap.taskId);
      return tx.ratingDispute.update({ where: { id: d.id }, data: { decidedAt: new Date(), ...data } as never });
    };
    expect(await failure(async (tx) => decide(tx, { status: 'upheld', decidedById: await idOf(tx, DIRECTOR), decision: 'Rating kept.' }))).toBeNull();
    expect(await failure(async (tx) => decide(tx, { status: 'changed', decidedById: await idOf(tx, DIRECTOR), decision: 'Fair point.', newRating: 4 }))).toBeNull();
    expect(await failure(async (tx) => decide(tx, { status: 'upheld', decidedById: await idOf(tx, DIRECTOR), decision: ' ' }))).toContain('rating_disputes_decision');
    expect(await failure(async (tx) => decide(tx, { status: 'upheld', decision: 'Rating kept.' }))).toContain('rating_disputes_decision');
    expect(await failure(async (tx) => decide(tx, { status: 'changed', decidedById: await idOf(tx, DIRECTOR), decision: 'Fair point.' }))).toContain('rating_disputes_decision');
    expect(await failure(async (tx) => decide(tx, { status: 'changed', decidedById: await idOf(tx, DIRECTOR), decision: 'Fair point.', newRating: 3 }))).toContain('rating_disputes_decision');
    expect(await failure(async (tx) => decide(tx, { status: 'changed', decidedById: await idOf(tx, DIRECTOR), decision: 'Fair point.', newRating: 7 }))).toContain('rating_disputes_decision');
    expect(await failure(async (tx) => decide(tx, { status: 'upheld', decidedById: await idOf(tx, DEV2), decision: 'I say so.' }))).toContain('rating_disputes_values');
  });

  it('an open dispute can only be decided, not edited; a decided one never changes and is never deleted', async () => {
    expect(await failure(async (tx) => { const { c, snap } = await released(tx); const d = await raise(tx, c.id, snap.taskId); await tx.ratingDispute.update({ where: { id: d.id }, data: { reason: 'something else entirely' } }); })).toContain('cannot be edited, only decided');
    expect(await failure(async (tx) => { const { c, snap } = await released(tx); const d = await raise(tx, c.id, snap.taskId); await tx.ratingDispute.update({ where: { id: d.id }, data: { ratingAtRaise: 2 } }); })).toContain('cannot be edited, only decided');
    expect(
      await failure(async (tx) => {
        const { c, snap } = await released(tx);
        const d = await raise(tx, c.id, snap.taskId);
        const done = await tx.ratingDispute.update({ where: { id: d.id }, data: { status: 'upheld', decidedById: await idOf(tx, DIRECTOR), decision: 'Rating kept.', decidedAt: new Date() } });
        await tx.ratingDispute.update({ where: { id: done.id }, data: { decision: 'changed my mind' } });
      }),
    ).toContain('decided rating dispute cannot be changed');
    expect(await failure(async (tx) => { const { c, snap } = await released(tx); const d = await raise(tx, c.id, snap.taskId); await tx.ratingDispute.delete({ where: { id: d.id } }); })).toContain('never deleted');
  });
});

describe('the Module 6 routes are wired in', () => {
  it('every route needs a login', async () => {
    const anon = t.anonymous();
    const id = '7d3f1c9a-2b4e-4a6d-8c1f-0e5a9b7c3d21';
    await anon.get('/api/v1/performance/live').expect(401);
    await anon.get('/api/v1/performance/team').expect(401);
    await anon.get('/api/v1/scorecards').expect(401);
    await anon.get(`/api/v1/scorecards/${id}`).expect(401);
    await anon.post(`/api/v1/scorecards/${id}/remark`).send({}).expect(401);
    await anon.post(`/api/v1/scorecards/${id}/release`).send({}).expect(401);
    await anon.post(`/api/v1/scorecards/${id}/acknowledge`).send({}).expect(401);
    await anon.get('/api/v1/disputes').expect(401);
    await anon.post('/api/v1/disputes').send({}).expect(401);
    await anon.post(`/api/v1/disputes/${id}/decide`).send({}).expect(401);
    await anon.get('/api/v1/settings/score-weights').expect(401);
    await anon.post('/api/v1/settings/score-weights').send({}).expect(401);
  });

  it('the score weights: the Owner, Director and CTO may read (settings.view), developers may not; only the Director saves (performance.weights)', async () => {
    await t.as(DEV1).get('/api/v1/settings/score-weights').expect(403);
    await t.as(DEV1).post('/api/v1/settings/score-weights').send({}).expect(403);
    await t.as(CTO).post('/api/v1/settings/score-weights').send({}).expect(403);
    // a request that breaks the contract is refused before it reaches the service (the Director is allowed to save)
    await t.as(DIRECTOR).post('/api/v1/settings/score-weights').send({ kind: 'standard' }).expect(400);
    await t.as(DIRECTOR).post('/api/v1/settings/score-weights').send({ kind: 'standard', weights: { quality: '35' }, reason: 'x' }).expect(400);
  });

  it('the team table needs performance.view_team (developers have none)', async () => {
    await t.as(DEV1).get('/api/v1/performance/team').expect(403);
  });

  it('requests that break the contract are refused before they reach a service', async () => {
    await t.as(DEV2).get('/api/v1/scorecards/not-a-uuid').expect(400);
    await t.as(DEV2).get('/api/v1/scorecards?month=2026-13').expect(400);
    await t.as(DEV2).get('/api/v1/performance/live?empId=nobody').expect(400);
    await t.as(DEV2).post('/api/v1/disputes').send({}).expect(400);
    await t.as(DEV2).post('/api/v1/disputes').send({ scorecardId: '7d3f1c9a-2b4e-4a6d-8c1f-0e5a9b7c3d21', taskNumber: 'TSK-0001', reason: 'short' }).expect(400);
    await t.as(DIRECTOR).post('/api/v1/disputes/7d3f1c9a-2b4e-4a6d-8c1f-0e5a9b7c3d21/decide').send({ change: true, decision: 'ok then', newRating: 9 }).expect(400);
    await t.as(CTO).post('/api/v1/scorecards/7d3f1c9a-2b4e-4a6d-8c1f-0e5a9b7c3d21/remark').send({ remark: 'x' }).expect(400);
  });

  it('the approvals inbox still answers for a logged-in person (the performance provider is registered; a module that fails never empties it)', async () => {
    const res = await t.as(DIRECTOR).get('/api/v1/approvals').expect(200);
    expect(res.body).toMatchObject({ routedUp: expect.any(Number) });
    expect(Array.isArray(res.body.items)).toBe(true);
    // an item type that M6 owns is routed to its provider (without one it would be 404 "no provider"): a missing item is 403
    // "not waiting for you" (501 while the provider's list is still a stub)
    const missing = await t.as(DIRECTOR).post('/api/v1/approvals/scorecard:7d3f1c9a-2b4e-4a6d-8c1f-0e5a9b7c3d21/approve').send({});
    expect([403, 501]).toContain(missing.status);
  });
});
