import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

const OWNER = 'ACV-0001';
const CEO = 'ACV-0002';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const DEV3 = 'ACV-0008';

let t: TestApp;
let prisma: PrismaClient;

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
});
afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const departments = async () => (await t.as(DEV1).get('/api/v1/org/departments').expect(200)).body;
const audit = (action: string, targetId: string) => prisma.auditLog.findMany({ where: { action, targetId }, include: { actor: true }, orderBy: { occurredAt: 'asc' } });

describe('M1 departments and offices (Owner and CEO)', () => {
  it('only the Owner and the CEO can create, edit and deactivate them', async () => {
    const body = { name: 'Legal', reason: 'New legal team' };
    for (const actor of [DIRECTOR, CTO, DEV1]) {
      await t.as(actor).post('/api/v1/org/departments').send(body).expect(403);
      await t.as(actor).patch('/api/v1/org/departments/dep-eng').send({ name: 'Renamed', reason: 'not allowed' }).expect(403);
      await t.as(actor).post('/api/v1/org/offices').send({ name: 'Lahore Office', reason: 'not allowed' }).expect(403);
    }
    expect(await prisma.department.count({ where: { name: 'Legal' } })).toBe(0);
  });

  it('creates a department with an explicit head, audited with who and why', async () => {
    const res = await t.as(CEO).post('/api/v1/org/departments').send({ name: 'Legal', headEmpId: DIRECTOR, reason: 'New legal team' }).expect(201);
    expect(res.body).toEqual({ id: 'dep-legal', name: 'Legal', headEmpId: DIRECTOR });
    const stored = await prisma.department.findUniqueOrThrow({ where: { code: 'dep-legal' }, include: { head: true } });
    expect(stored.head?.empId).toBe(DIRECTOR);
    const [entry] = await audit('org.department.created', 'dep-legal');
    expect(entry.actor?.empId).toBe(CEO);
    expect(entry.reason).toBe('New legal team');
    await t.as(CEO).post('/api/v1/org/departments').send({ name: 'legal', reason: 'duplicate name' }).expect(409);
  });

  it('a head must be a real employee who is still with the company', async () => {
    await t.as(CEO).post('/api/v1/org/departments').send({ name: 'Ghosts', headEmpId: 'ACV-9999', reason: 'unknown person' }).expect(404);
    await prisma.employee.update({ where: { empId: DEV3 }, data: { status: 'left' } });
    await t.as(CEO).post('/api/v1/org/departments').send({ name: 'Ghosts', headEmpId: DEV3, reason: 'left the company' }).expect(400);
    await prisma.employee.update({ where: { empId: DEV3 }, data: { status: 'active' } });
  });

  it('the head is the one that was set, never worked out from reporting lines; head changes are audited', async () => {
    expect((await departments()).departments.find((d: { id: string }) => d.id === 'dep-eng').headEmpId).toBe(CTO);
    // Make an ordinary developer the head: the stored head wins, even though the CTO is more senior.
    await t.as(OWNER).patch('/api/v1/org/departments/dep-eng').send({ headEmpId: DEV2, reason: 'Mariam leads the platform team' }).expect(200);
    expect((await departments()).departments.find((d: { id: string }) => d.id === 'dep-eng').headEmpId).toBe(DEV2);
    const [entry] = await audit('org.department.head_changed', 'dep-eng');
    expect(entry.actor?.empId).toBe(OWNER);
    expect(entry.reason).toBe('Mariam leads the platform team');
    expect(entry.details).toEqual({ before: { head: CTO }, after: { head: DEV2 } });
    // reporting relationships are untouched: they stay the source of truth for hierarchy and approvals
    expect((await prisma.employee.findUniqueOrThrow({ where: { empId: DEV2 } })).reportsToId).toBe((await prisma.employee.findUniqueOrThrow({ where: { empId: CTO } })).id);
    expect(await t.as(DEV2).get(`/api/v1/approvals/route/${DEV2}?date=${day(0)}`).expect(200).then((r) => r.body.approver)).toBe(CTO);
    // and the head can be removed
    await t.as(CEO).patch('/api/v1/org/departments/dep-eng').send({ headEmpId: null, reason: 'Vacant for now' }).expect(200);
    expect((await departments()).departments.find((d: { id: string }) => d.id === 'dep-eng').headEmpId).toBeNull();
    await t.as(CEO).patch('/api/v1/org/departments/dep-eng').send({ headEmpId: CTO, reason: 'The CTO leads again' }).expect(200);
    await t.as(CEO).patch('/api/v1/org/departments/dep-eng').send({ headEmpId: CTO, reason: 'no change at all' }).expect(400);
  });

  it('renames a department (names stay unique) and needs a reason', async () => {
    await t.as(CEO).patch('/api/v1/org/departments/dep-legal').send({ name: 'Legal and Compliance', reason: 'Wider scope' }).expect(200);
    expect((await audit('org.department.updated', 'dep-legal'))[0].details).toEqual({ before: { name: 'Legal' }, after: { name: 'Legal and Compliance' } });
    await t.as(CEO).patch('/api/v1/org/departments/dep-legal').send({ name: 'Sales', reason: 'duplicate' }).expect(409);
    await t.as(CEO).patch('/api/v1/org/departments/dep-legal').send({ name: 'Another Name' }).expect(400);
  });

  it('deactivates a department only when nobody works in it, and keeps the record', async () => {
    await t.as(CEO).post('/api/v1/org/departments/dep-eng/deactivate').send({ reason: 'closing development' }).expect(409);
    await t.as(CEO).post('/api/v1/org/departments/dep-legal/deactivate').send({ reason: 'Plan cancelled' }).expect(201);
    expect((await departments()).departments.map((d: { id: string }) => d.id)).not.toContain('dep-legal');
    expect(await prisma.department.count({ where: { code: 'dep-legal', archivedAt: { not: null } } })).toBe(1); // archived, not deleted
    await t.as(CEO).patch('/api/v1/org/departments/dep-legal').send({ name: 'Back again', reason: 'archived' }).expect(404);
  });

  it('manages offices the same way', async () => {
    const created = await t.as(CEO).post('/api/v1/org/offices').send({ name: 'Lahore Office', city: 'Lahore', reason: 'New city' }).expect(201);
    expect(created.body).toEqual({ id: 'off-lahore-office', name: 'Lahore Office', city: 'Lahore' });
    await t.as(CEO).post('/api/v1/org/offices').send({ name: 'lahore office', reason: 'duplicate' }).expect(409);
    await t.as(OWNER).patch('/api/v1/org/offices/off-lahore-office').send({ city: 'Lahore (DHA)', reason: 'Moved' }).expect(200);
    await t.as(CEO).post('/api/v1/org/offices/off-khi/deactivate').send({ reason: 'closing' }).expect(409); // people work there
    await t.as(CEO).post('/api/v1/org/offices/off-lahore-office/deactivate').send({ reason: 'Plan cancelled' }).expect(201);
    expect((await departments()).offices.map((o: { id: string }) => o.id)).not.toContain('off-lahore-office');
    expect((await audit('org.office.created', 'off-lahore-office'))[0].actor?.empId).toBe(CEO);
  });

  it('appears in the recent changes feed', async () => {
    const feed = (await t.as(DIRECTOR).get('/api/v1/org/changes').expect(200)).body as Array<{ kind: string; summary: string }>;
    expect(feed.some((f) => f.kind === 'department' && f.summary.includes('Legal'))).toBe(true);
    expect(feed.some((f) => f.kind === 'office')).toBe(true);
  });
});

describe('M1 stand-ins: conflicts and the next eligible approver', () => {
  it('a stand-in cannot be away themselves on the same dates, and a manager cannot be away while covering for someone', async () => {
    // The Director is away, covered by the CEO.
    await t.as(DIRECTOR).post('/api/v1/stand-ins').send({ standInEmpId: CEO, startsOn: day(20), endsOn: day(25) }).expect(201);
    // The CTO cannot name the Director as stand-in on overlapping dates: the Director is away.
    const away = await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: DIRECTOR, startsOn: day(23), endsOn: day(28) }).expect(409);
    expect(away.body.code).toBe('stand_in_is_away');
    // On other dates it works.
    await t.as(CTO).post('/api/v1/stand-ins').send({ standInEmpId: DIRECTOR, startsOn: day(30), endsOn: day(33) }).expect(201);
    // Now the Director covers for the CTO on those dates, so the Director cannot go away then.
    const covering = await t.as(DIRECTOR).post('/api/v1/stand-ins').send({ startsOn: day(32), endsOn: day(34) }).expect(409);
    expect(covering.body.code).toBe('manager_is_covering');
    // and still no overlapping periods for the same manager
    await t.as(DIRECTOR).post('/api/v1/stand-ins').send({ standInEmpId: CEO, startsOn: day(24), endsOn: day(26) }).expect(409);
  });

  it('approval falls back to the next eligible person upward: a person who has left is passed over', async () => {
    await prisma.employee.update({ where: { empId: CTO }, data: { status: 'left' } });
    const step = (await t.as(DEV1).get(`/api/v1/approvals/route/${DEV1}?date=${day(0)}`).expect(200)).body;
    expect(step).toMatchObject({ approver: DIRECTOR, seat: DIRECTOR });
    expect(step.skipped).toEqual([{ seat: CTO, reason: 'not_active' }]);
    await prisma.employee.update({ where: { empId: CTO }, data: { status: 'active' } });
    expect((await t.as(DEV1).get(`/api/v1/approvals/route/${DEV1}?date=${day(0)}`).expect(200)).body.approver).toBe(CTO);
  });

  it('an empty stand-in means nobody is delegated: approval simply goes up the chain for those dates', async () => {
    const created = await t.as(CTO).post('/api/v1/stand-ins').send({ startsOn: day(40), endsOn: day(42), reason: 'Away, nobody covering' }).expect(201);
    expect(created.body.standIn).toBeNull();
    const step = (await t.as(DEV1).get(`/api/v1/approvals/route/${DEV1}?date=${day(41)}`).expect(200)).body;
    expect(step).toMatchObject({ approver: DIRECTOR, via: 'manager' });
    expect(step.skipped).toEqual([{ seat: CTO, reason: 'away_no_stand_in' }]);
  });
});
