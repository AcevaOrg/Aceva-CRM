import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalsService } from '../src/approvals/approvals.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

const OWNER = 'ACV-0001'; // the CEO / Founder / Owner (Level 1): sees everything, changes nothing
const DIRECTOR = 'ACV-0003'; // Level 2: the org administrator and the only approver
const CTO = 'ACV-0004'; // Level 3, reports to the Director
let HR = ''; // test-only HR officer (not in the demo seed), see helpers/people.ts
const FINANCE = 'ACV-0010';
const SALES1 = 'ACV-0009';
const SALES2 = 'ACV-0012';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const DEV3 = 'ACV-0008';
const DEV4 = 'ACV-0011';
const DEV5 = 'ACV-0013';

let t: TestApp;
let prisma: PrismaClient;

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  HR = t.fixtures.HR;
  prisma = createTestPrisma();
});
afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase(); // leave a clean, seeded database for the next test file
}, 120000);

const teamOf = async (empId: string): Promise<string[]> =>
  (await t.as(empId).get('/api/v1/org/team').expect(200)).body.map((m: { empId: string }) => m.empId);

const auditFor = (action: string, targetId: string) =>
  prisma.auditLog.findMany({ where: { action, targetId }, include: { actor: true }, orderBy: { occurredAt: 'asc' } });

/** The closure table must always equal the tree implied by reports_to_id. */
async function expectClosureMatchesTree() {
  const rows = await prisma.$queryRaw<Array<{ missing: bigint; extra: bigint }>>`
    WITH RECURSIVE tree(a, d, depth) AS (
      SELECT id, id, 0 FROM employees
      UNION ALL
      SELECT t.a, e.id, t.depth + 1 FROM tree t JOIN employees e ON e.reports_to_id = t.d
    )
    SELECT
      (SELECT count(*) FROM tree t WHERE NOT EXISTS (SELECT 1 FROM reporting_closure c WHERE c.ancestor_id = t.a AND c.descendant_id = t.d AND c.depth = t.depth)) AS missing,
      (SELECT count(*) FROM reporting_closure c WHERE NOT EXISTS (SELECT 1 FROM tree t WHERE c.ancestor_id = t.a AND c.descendant_id = t.d AND c.depth = t.depth)) AS extra`;
  expect({ missing: Number(rows[0].missing), extra: Number(rows[0].extra) }).toEqual({ missing: 0, extra: 0 });
}

describe('M1 reporting-line changes (the Director)', () => {
  it('moves a person and updates visibility immediately for everyone (no stale hierarchy)', async () => {
    expect(await teamOf(CTO)).toContain(DEV5);
    expect(await teamOf(FINANCE)).not.toContain(DEV5);

    const res = await t
      .as(DIRECTOR)
      .patch(`/api/v1/org/employees/${DEV5}/reporting-line`)
      .send({ reportsToEmpId: FINANCE, reason: 'Moved to the finance team for the audit project' })
      .expect(200);
    expect(res.body).toEqual({ empId: DEV5, reportsTo: FINANCE });

    expect(await teamOf(CTO)).not.toContain(DEV5); // the old manager lost access at once
    expect(await teamOf(FINANCE)).toContain(DEV5); // the new manager gained it
    expect(await teamOf(DIRECTOR)).toContain(DEV5); // still below the Director
    await t.as(CTO).get(`/api/v1/org/team/${DEV5}`).expect(403);
    await t.as(FINANCE).get(`/api/v1/org/team/${DEV5}`).expect(200);
    await expectClosureMatchesTree();
  });

  it('moves a whole branch together (a manager and everyone below them)', async () => {
    // Move the Finance person (with DEV5 now below them) under the CTO, then back under the Director.
    await t
      .as(DIRECTOR)
      .patch(`/api/v1/org/employees/${FINANCE}/reporting-line`)
      .send({ reportsToEmpId: CTO, reason: 'Finance supports the development budget for a while' })
      .expect(200);
    expect(await teamOf(CTO)).toEqual(expect.arrayContaining([FINANCE, DEV5]));
    await expectClosureMatchesTree();

    await t
      .as(DIRECTOR)
      .patch(`/api/v1/org/employees/${FINANCE}/reporting-line`)
      .send({ reportsToEmpId: DIRECTOR, reason: 'Restoring the documented structure' })
      .expect(200);
    expect(await teamOf(CTO)).not.toContain(FINANCE);
    expect(await teamOf(CTO)).not.toContain(DEV5);
    await expectClosureMatchesTree();
  });

  it('records who changed what and why, in the audit log, history and profile changes', async () => {
    const [entry] = await auditFor('org.reporting_line.changed', DEV5);
    expect(entry.actor?.empId).toBe(DIRECTOR);
    expect(entry.reason).toBe('Moved to the finance team for the audit project');
    expect(entry.details).toEqual({ before: { reportsTo: CTO }, after: { reportsTo: FINANCE } });
    const history = await prisma.employmentHistory.findFirstOrThrow({
      where: { employee: { empId: DEV5 }, eventType: 'reporting_line_changed' },
    });
    expect(history.details).toEqual({ before: { reportsTo: CTO }, after: { reportsTo: FINANCE } });
    const change = await prisma.profileChange.findFirstOrThrow({ where: { employee: { empId: DEV5 }, field: 'reportsTo' } });
    expect([change.oldValue, change.newValue, change.section]).toEqual([CTO, FINANCE, 'job']);
  });

  it('requires a reason', async () => {
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV5}/reporting-line`).send({ reportsToEmpId: CTO }).expect(400);
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV5}/reporting-line`).send({ reportsToEmpId: CTO, reason: 'no' }).expect(400);
  });

  const violation = async (actor: string, target: string, manager: string) => {
    const res = await t
      .as(actor)
      .patch(`/api/v1/org/employees/${target}/reporting-line`)
      .send({ reportsToEmpId: manager, reason: 'validation test' })
      .expect(400);
    return res.body.violations.map((v: { code: string }) => v.code) as string[];
  };

  it('prevents reporting cycles', async () => {
    expect(await violation(DIRECTOR, CTO, DEV1)).toEqual(['cycle']); // the developer is below the CTO
    expect(await violation(DIRECTOR, FINANCE, DEV5)).toEqual(['cycle']); // DEV5 now reports to Finance
    await expectClosureMatchesTree();
  });

  it('prevents a person reporting to themselves', async () => {
    expect(await violation(DIRECTOR, DEV1, DEV1)).toEqual(['self']);
  });

  it('prevents reporting to someone at a lower level', async () => {
    expect(await violation(DIRECTOR, SALES1, DEV1)).toEqual(['manager_below_employee']);
  });

  it('refuses every same-level line: none is configured any more (not even CTO to Director)', async () => {
    expect(await prisma.sameLevelReportingRule.count()).toBe(0);
    expect(await violation(DIRECTOR, SALES1, SALES2)).toEqual(['same_level_not_allowed']);
    expect(await violation(DIRECTOR, FINANCE, SALES1)).toEqual(['same_level_not_allowed']);
    expect(await violation(DIRECTOR, DEV1, DEV2)).toEqual(['same_level_not_allowed']);
    await expectClosureMatchesTree();
  });

  it('refuses a move that would put someone under a manager the caller cannot reach', async () => {
    // The owner is above the Director, so the Director cannot place people under the owner.
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${HR}/reporting-line`).send({ reportsToEmpId: OWNER, reason: 'out of scope test' }).expect(403);
  });

  it('refuses to change the owner, a person above the caller, or the caller themselves', async () => {
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${OWNER}/reporting-line`).send({ reportsToEmpId: DIRECTOR, reason: 'attack on the owner' }).expect(403);
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DIRECTOR}/reporting-line`).send({ reportsToEmpId: CTO, reason: 'self change' }).expect(403);
  });

  it('the CEO / Founder / Owner changes no reporting line at all (view only)', async () => {
    await t.as(OWNER).patch(`/api/v1/org/employees/${DEV1}/reporting-line`).send({ reportsToEmpId: DIRECTOR, reason: 'the owner tries a move' }).expect(403);
    await t.as(OWNER).patch(`/api/v1/org/employees/${DIRECTOR}/reporting-line`).send({ reportsToEmpId: OWNER, reason: 'the owner tries a move' }).expect(403);
  });

  it('rejects "no change" requests', async () => {
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV1}/reporting-line`).send({ reportsToEmpId: CTO, reason: 'same manager again' }).expect(400);
  });

  it('serialises simultaneous changes so the tree can never be corrupted', async () => {
    // Several moves racing each other; each is valid on its own.
    const moves = [
      t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV2}/reporting-line`).send({ reportsToEmpId: SALES1, reason: 'parallel move 1' }),
      t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV3}/reporting-line`).send({ reportsToEmpId: SALES2, reason: 'parallel move 2' }),
      t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV2}/reporting-line`).send({ reportsToEmpId: SALES2, reason: 'parallel move 3' }),
    ];
    const results = await Promise.all(moves.map((m) => m.then((r) => r.status)));
    expect(results.every((s) => s === 200 || s === 400)).toBe(true);
    await expectClosureMatchesTree();
  });
});

describe('M1 level changes (the Director)', () => {
  it('changes level and role, and the new permissions apply on the very next request', async () => {
    expect((await t.as(DEV1).get('/api/v1/access/me').expect(200)).body.permissions).not.toContain('sales.own');

    const res = await t
      .as(DIRECTOR)
      .patch(`/api/v1/org/employees/${DEV1}/level`)
      .send({ level: 4, reason: 'Moves to the sales team' })
      .expect(200);
    expect(res.body).toEqual({ empId: DEV1, level: 4, roleKey: 'sales' }); // the default Level 4 role

    const me = (await t.as(DEV1).get('/api/v1/access/me').expect(200)).body;
    expect(me.level).toBe(4);
    expect(me.permissions).toContain('sales.own');
  });

  it('records who, what and why (before and after), plus history', async () => {
    const [entry] = await auditFor('org.level.changed', DEV1);
    expect(entry.actor?.empId).toBe(DIRECTOR);
    expect(entry.reason).toBe('Moves to the sales team');
    expect(entry.details).toEqual({ before: { level: 5, role: 'employee' }, after: { level: 4, role: 'sales' } });
    const history = await prisma.employmentHistory.findFirstOrThrow({ where: { employee: { empId: DEV1 }, eventType: 'level_changed' } });
    expect(history.reason).toBe('Moves to the sales team');
  });

  it('can name a non-default role of the level (the Level 4 finance role)', async () => {
    const res = await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV4}/level`).send({ level: 4, roleKey: 'finance', reason: 'Joins the finance team' }).expect(200);
    expect(res.body).toEqual({ empId: DEV4, level: 4, roleKey: 'finance' });
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV4}/level`).send({ level: 5, reason: 'Back to development' }).expect(200);
  });

  it('rejects a level change that would break the reporting lines', async () => {
    // Demoting the CTO to Level 5 would leave the developers (Level 5) reporting to someone at their own level.
    const res = await t.as(DIRECTOR).patch(`/api/v1/org/employees/${CTO}/level`).send({ level: 5, reason: 'validation test' }).expect(400);
    expect(res.body.violations.map((v: { code: string }) => v.code)).toContain('same_level_not_allowed');
    // A developer who now reports to a Level 4 sales person cannot become Level 3.
    const res2 = await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV2}/level`).send({ level: 3, roleKey: 'cto', reason: 'validation test' }).expect(400);
    expect(res2.body.violations.map((v: { code: string }) => v.code)).toContain('manager_below_employee');
  });

  it('rejects a role that does not belong to the requested level', async () => {
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV3}/level`).send({ level: 4, roleKey: 'director', reason: 'validation test' }).expect(400);
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV3}/level`).send({ level: 4, roleKey: 'level4_default', reason: 'a removed role' }).expect(400);
  });

  it('stops anyone assigning a level at or above their own (privilege escalation): the Director assigns Levels 3 to 5 only', async () => {
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV3}/level`).send({ level: 2, reason: 'make a second Director' }).expect(403);
    expect(await prisma.auditLog.count({ where: { action: 'access.denied', reason: 'level_not_assignable' } })).toBeGreaterThan(0);
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV3}/level`).send({ level: 1, reason: 'make an owner' }).expect(400); // not even a valid request
  });

  it('the CEO / Founder / Owner changes no level at all (view only)', async () => {
    await t.as(OWNER).patch(`/api/v1/org/employees/${DEV3}/level`).send({ level: 4, reason: 'the owner tries a promotion' }).expect(403);
    await t.as(OWNER).patch(`/api/v1/org/employees/${DIRECTOR}/level`).send({ level: 3, reason: 'the owner tries a demotion' }).expect(403);
  });

  it('requires a reason and rejects no-op changes', async () => {
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV3}/level`).send({ level: 4 }).expect(400);
    await t.as(DIRECTOR).patch(`/api/v1/org/employees/${DEV3}/level`).send({ level: 5, reason: 'already level five' }).expect(400);
  });

  it('keeps the database rule: a role must belong to the level', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE employees SET role_id = (SELECT id FROM roles WHERE key = 'director') WHERE emp_id = '${DEV3}'`),
    ).rejects.toThrow(/does not belong/);
  });
});

describe('M1 additional duties (Director)', () => {
  it('lets the Director give Finance duty, and permissions and 2FA follow', async () => {
    const res = await t.as(DIRECTOR).post(`/api/v1/org/employees/${DEV2}/duties`).send({ dutyKey: 'finance', reason: 'Covering for the finance team' }).expect(201);
    expect(res.body).toEqual({ empId: DEV2, duty: 'finance' });
    // 2FA is now mandatory for them: everything but finishing the login is refused until they set it up
    expect((await t.as(DEV2).get('/api/v1/org/team').expect(403)).body).toMatchObject({ code: 'auth_incomplete', stage: '2fa_setup_required' });
    const me = (await t.as(DEV2).get('/api/v1/auth/me').expect(200)).body;
    expect(me.duties).toEqual(['finance']);
    expect(me.permissions).toEqual(expect.arrayContaining(['finance.entry_create', 'payroll.prepare']));
    expect(me.twoFactorRequired).toBe(true);
    const [entry] = await auditFor('duty.assigned', DEV2);
    expect(entry).toMatchObject({ reason: 'Covering for the finance team' });
    expect(entry.actor?.empId).toBe(DIRECTOR);
  });

  it('rejects a duplicate duty and an unknown duty', async () => {
    await t.as(DIRECTOR).post(`/api/v1/org/employees/${DEV2}/duties`).send({ dutyKey: 'finance', reason: 'again please' }).expect(409);
    await t.as(DIRECTOR).post(`/api/v1/org/employees/${DEV2}/duties`).send({ dutyKey: 'nonsense', reason: 'unknown duty' }).expect(404);
  });

  it('only the Director may assign duties, and never to themselves or to people above', async () => {
    for (const actor of [OWNER, CTO, HR, FINANCE, DEV1]) {
      await t.as(actor).post(`/api/v1/org/employees/${DEV3}/duties`).send({ dutyKey: 'finance', reason: 'not allowed' }).expect(403);
    }
    await t.as(DIRECTOR).post(`/api/v1/org/employees/${DIRECTOR}/duties`).send({ dutyKey: 'finance', reason: 'self grant' }).expect(403);
    await t.as(DIRECTOR).post(`/api/v1/org/employees/${OWNER}/duties`).send({ dutyKey: 'finance', reason: 'above me' }).expect(403);
  });

  it('removes the permissions when the duty ends, keeping the record', async () => {
    await t.as(DIRECTOR).delete(`/api/v1/org/employees/${DEV2}/duties/finance`).send({ reason: 'Finance cover finished' }).expect(200);
    const me = (await t.as(DEV2).get('/api/v1/access/me').expect(200)).body;
    expect(me.permissions).not.toContain('finance.entry_create');
    expect(me.twoFactorRequired).toBe(false);
    expect(await prisma.employeeDuty.count({ where: { employee: { empId: DEV2 }, endedAt: { not: null } } })).toBe(1);
    expect((await auditFor('duty.ended', DEV2))[0].reason).toBe('Finance cover finished');
    // and the duty can be given again later
    await t.as(DIRECTOR).post(`/api/v1/org/employees/${DEV2}/duties`).send({ dutyKey: 'finance', reason: 'needed once more' }).expect(201);
  });
});

describe('M1 stand-in approvals', () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const START = day(30);
  const END = day(40);
  const during = day(35);
  let periodId: string;

  const route = async (requester: string, date: string, afterSeat?: string, as = requester) =>
    (await t.as(as).get(`/api/v1/approvals/route/${requester}?date=${date}${afterSeat ? `&afterSeat=${afterSeat}` : ''}`).expect(200)).body;

  it('routes to the direct manager normally', async () => {
    expect(await route(DEV4, during)).toMatchObject({ approver: CTO, seat: CTO, via: 'manager', skipped: [] });
  });

  it('lets a manager name a stand-in with start and end dates', async () => {
    const res = await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: DIRECTOR, startsOn: START, endsOn: END, reason: 'Annual leave' }).expect(201);
    periodId = res.body.id;
    expect(res.body).toMatchObject({ manager: CTO, standIn: DIRECTOR, startsOn: START, endsOn: END });
    expect((await auditFor('standin.created', periodId))[0].actor?.empId).toBe(CTO);
  });

  it('routes approvals to the stand-in only during the dates (boundaries included)', async () => {
    expect(await route(DEV4, during)).toMatchObject({ approver: DIRECTOR, seat: CTO, via: 'stand_in' });
    expect((await route(DEV4, START)).approver).toBe(DIRECTOR);
    expect((await route(DEV4, END)).approver).toBe(DIRECTOR);
    expect((await route(DEV4, day(29))).approver).toBe(CTO);
    expect((await route(DEV4, day(41))).approver).toBe(CTO);
  });

  it('moves up one reporting relationship at a time, and stops at the Director (the owner approves only for him)', async () => {
    const first = await route(DEV4, during);
    const second = await route(DEV4, during, first.seat);
    expect(second).toMatchObject({ seat: DIRECTOR, approver: DIRECTOR, via: 'manager' });
    const third = await route(DEV4, during, second.seat);
    expect(third.approver).toBeNull();
    expect(third.skipped).toEqual([{ seat: OWNER, reason: 'direct_reports_only' }]);
  });

  it("sends the Director's OWN request to the CEO / Founder / Owner", async () => {
    expect(await route(DIRECTOR, during)).toMatchObject({ approver: OWNER, seat: OWNER, via: 'manager', skipped: [] });
  });

  it("validates the stand-in: must be authorized, active and at the manager's level or above, and never the owner", async () => {
    // a developer (Level 5) cannot stand in for a Level 3 manager
    await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: DEV4, startsOn: day(50), endsOn: day(55) }).expect(400);
    // a Level 4 person cannot stand in for the CTO either
    await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: HR, startsOn: day(50), endsOn: day(55) }).expect(400);
    // the CEO / Founder / Owner approves only the Director's own items, so is never a stand-in
    const owner = await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: OWNER, startsOn: day(50), endsOn: day(55) }).expect(400);
    expect(JSON.stringify(owner.body)).toMatch(/cannot be a stand-in/);
    // not yourself, not an unknown person, not someone who left
    await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: CTO, startsOn: day(50), endsOn: day(55) }).expect(400);
    await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: 'ACV-9999', startsOn: day(50), endsOn: day(55) }).expect(404);
    await prisma.employee.update({ where: { empId: DIRECTOR }, data: { status: 'left' } });
    try {
      await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: DIRECTOR, startsOn: day(50), endsOn: day(55) }).expect(400);
    } finally {
      await prisma.employee.update({ where: { empId: DIRECTOR }, data: { status: 'active' } });
    }
    // someone without the approval permission
    await prisma.rolePermission.deleteMany({ where: { role: { key: 'director' }, permission: { key: 'approval.approve' } } });
    try {
      await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: DIRECTOR, startsOn: day(50), endsOn: day(55) }).expect(400); // higher level, but not allowed to approve
    } finally {
      await prisma.rolePermission.create({ data: { role: { connect: { key: 'director' } }, permission: { connect: { key: 'approval.approve' } } } });
    }
  });

  it('validates the dates (no end before start, nothing already over) and overlaps', async () => {
    await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: DIRECTOR, startsOn: day(50), endsOn: day(49) }).expect(400);
    await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: DIRECTOR, startsOn: day(-10), endsOn: day(-5) }).expect(400);
    await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: DIRECTOR, startsOn: day(38), endsOn: day(45) }).expect(409);
  });

  it('only people allowed to manage stand-ins can create them (not employees, not the owner)', async () => {
    await t.as(DEV4).post('/api/v1/stand-ins').send({ standInEmpId: CTO, startsOn: day(60), endsOn: day(61) }).expect(403);
    await t.as(OWNER).post('/api/v1/stand-ins').send({ startsOn: day(60), endsOn: day(61) }).expect(403);
  });

  it('gives the Director no possible stand-in: the CTO is below him and the owner is never a stand-in', async () => {
    // (A stand-in who is also the requester is covered by the pure routing tests; with strictly higher reporting lines
    // nobody below a manager can be that manager's stand-in.)
    await t.as(DIRECTOR).post('/api/v1/stand-ins').send({ standInEmpId: CTO, startsOn: day(80), endsOn: day(85) }).expect(400);
    await t.as(DIRECTOR).post('/api/v1/stand-ins').send({ standInEmpId: OWNER, startsOn: day(80), endsOn: day(85) }).expect(400);
  });

  it('routes to the next level up when the manager is away with no stand-in', async () => {
    const created = await t.as(CTO).post('/api/v1/stand-ins').send({ startsOn: day(90), endsOn: day(95), reason: 'Away, nobody covering' }).expect(201);
    expect(created.body.standIn).toBeNull();
    const step = await route(DEV4, day(92));
    expect(step).toMatchObject({ approver: DIRECTOR, seat: DIRECTOR });
    expect(step.skipped).toEqual([{ seat: CTO, reason: 'away_no_stand_in' }]);

    // When the Director is away with nobody covering, the CTO's request waits: it never goes up to the owner.
    const directorAway = await t.as(DIRECTOR).post('/api/v1/stand-ins').send({ startsOn: day(90), endsOn: day(95), reason: 'Away, nobody covering' }).expect(201);
    const waiting = await route(CTO, day(92));
    expect(waiting.approver).toBeNull();
    expect(waiting.skipped).toEqual([
      { seat: DIRECTOR, reason: 'away_no_stand_in' },
      { seat: OWNER, reason: 'direct_reports_only' },
    ]);

    await t.as(DIRECTOR).delete(`/api/v1/stand-ins/${directorAway.body.id}`).send({ reason: 'back from leave' }).expect(200);
    await t.as(CTO).delete(`/api/v1/stand-ins/${created.body.id}`).send({ reason: 'back from leave' }).expect(200);
    expect((await route(DEV4, day(92))).approver).toBe(CTO); // revoked periods are ignored
  });

  it('lets only the manager (or the Director above) end a period, and records why', async () => {
    await t.as(DEV4).delete(`/api/v1/stand-ins/${periodId}`).send({ reason: 'not my period' }).expect(403);
    await t.as(OWNER).delete(`/api/v1/stand-ins/${periodId}`).send({ reason: 'the owner manages nothing' }).expect(403);
    await t.as(DIRECTOR).delete(`/api/v1/stand-ins/${periodId}`).send({ reason: 'CTO is back early' }).expect(200);
    expect((await auditFor('standin.revoked', periodId))[0]).toMatchObject({ reason: 'CTO is back early' });
    await t.as(DIRECTOR).delete(`/api/v1/stand-ins/${periodId}`).send({ reason: 'twice is an error' }).expect(409);
    expect((await route(DEV4, during)).approver).toBe(CTO);
  });

  it('lists away periods for people in scope and for the stand-in', async () => {
    const created = await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: DIRECTOR, startsOn: day(70), endsOn: day(72) }).expect(201);
    const asStandIn = (await t.as(DIRECTOR).get('/api/v1/stand-ins').expect(200)).body.map((s: { id: string }) => s.id);
    expect(asStandIn).toContain(created.body.id);
    const asDev = (await t.as(DEV4).get('/api/v1/stand-ins').expect(200)).body.map((s: { id: string }) => s.id);
    expect(asDev).not.toContain(created.body.id); // beside/above: not visible
  });
});

describe('M1 fixed business rules', () => {
  it('nobody approves their own request: the shared approval check refuses it', async () => {
    const approvals = t.app.get(ApprovalsService);
    const cto = { id: 'x', empId: CTO, fullName: 'x', levelNumber: 3, roleKey: 'cto' };
    expect(await approvals.canApprove(cto, CTO)).toEqual({ allowed: false, reason: 'self_approval' });
    await expect(approvals.assertCanApprove(cto, CTO)).rejects.toThrow(/self_approval/);
  });

  it('only the routed approver may approve (the CTO, not the Director, for a developer\'s request)', async () => {
    const asCto = await t.as(CTO).get(`/api/v1/approvals/can-approve/${DEV4}`).expect(200);
    expect(asCto.body).toEqual({ allowed: true });
    const asDirector = await t.as(DIRECTOR).get(`/api/v1/approvals/can-approve/${DEV4}`).expect(200);
    expect(asDirector.body).toEqual({ allowed: false, reason: 'not_the_routed_approver' });
    // a person cannot even ask to approve themselves (and the attempt is logged)
    await t.as(CTO).get(`/api/v1/approvals/can-approve/${CTO}`).expect(403);
  });

  it("the CEO / Founder / Owner may approve only the Director's own items", async () => {
    expect((await t.as(OWNER).get(`/api/v1/approvals/can-approve/${DIRECTOR}`).expect(200)).body).toEqual({ allowed: true });
    for (const requester of [CTO, DEV4, FINANCE, SALES1]) {
      expect((await t.as(OWNER).get(`/api/v1/approvals/can-approve/${requester}`).expect(200)).body, requester).toEqual({ allowed: false, reason: 'not_the_routed_approver' });
    }
  });

  it("the CTO's own requests go to the Director (strictly one level up; no same-level rule is needed)", async () => {
    const step = (await t.as(CTO).get(`/api/v1/approvals/route/${CTO}?date=${new Date().toISOString().slice(0, 10)}`).expect(200)).body;
    expect(step).toMatchObject({ approver: DIRECTOR, via: 'manager' });
  });

  it('tasks move down the hierarchy only', async () => {
    const can = async (actor: string, assignee: string) =>
      (await t.as(actor).get(`/api/v1/access/can-assign-task/${assignee}`).expect(200)).body.allowed;
    expect(await can(CTO, DEV4)).toBe(true); // down
    expect(await can(DIRECTOR, DEV4)).toBe(true); // down, two levels
    expect(await can(OWNER, DEV4)).toBe(true); // the direction rule only: assigning also needs task.assign, which the owner does not have
    expect(await can(DEV4, CTO)).toBe(false); // up
    expect(await can(CTO, SALES1)).toBe(false); // beside / other branch
    expect(await can(CTO, CTO)).toBe(false); // not to yourself
    expect(await can(DEV4, DEV2)).toBe(false); // beside
  });
});

describe('M1 people who have left cannot act', () => {
  it('rejects a session whose employee has left, and the ended session never comes back', async () => {
    await prisma.employee.update({ where: { empId: HR }, data: { status: 'left' } });
    await t.as(HR).get('/api/v1/access/me').expect(401);
    await prisma.employee.update({ where: { empId: HR }, data: { status: 'active' } });
    await t.as(HR).get('/api/v1/access/me').expect(401); // the session was ended when they left; it is not revived
    await (await t.signIn(HR)).get('/api/v1/access/me').expect(200); // a fresh login works
  });
});

describe('M1 recent changes feed', () => {
  it('describes the changes made above in plain words, with who and why', async () => {
    const feed = (await t.as(DIRECTOR).get('/api/v1/org/changes').expect(200)).body as Array<{ kind: string; summary: string; reason: string; by: string }>;
    expect(feed.length).toBeGreaterThan(5);
    expect(feed.map((f) => f.kind)).toEqual(expect.arrayContaining(['level', 'reporting_line', 'duty', 'stand_in']));
    const line = feed.find((f) => f.kind === 'reporting_line' && f.summary.includes('Nida Aslam'));
    expect(line).toMatchObject({ by: DIRECTOR });
    expect(line?.reason).toBeTruthy();
  });
});

describe('M1 audit trail', () => {
  it('has an audit record, with actor and reason, for every level, line, duty and stand-in change made above', async () => {
    const actions = (
      await prisma.auditLog.groupBy({ by: ['action'], where: { outcome: 'success' }, _count: true })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['org.level.changed', 'org.reporting_line.changed', 'duty.assigned', 'duty.ended', 'standin.created', 'standin.revoked']),
    );
    const missingWho = await prisma.auditLog.count({ where: { outcome: 'success', action: { startsWith: 'org.' }, OR: [{ actorId: null }, { reason: null }] } });
    expect(missingWho).toBe(0);
  });

  it('cannot be edited or deleted', async () => {
    await expect(prisma.$executeRawUnsafe('UPDATE audit_log SET reason = \'tampered\'')).rejects.toThrow(/insert-only/);
    await expect(prisma.$executeRawUnsafe('DELETE FROM audit_log')).rejects.toThrow(/insert-only/);
  });
});
