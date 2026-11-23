import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMS_NOTIFICATIONS_CONSUMER } from '../src/comms/comms-notifications.consumer';
import { OutboxConsumerRunner } from '../src/events/outbox-consumer-runner.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 14 announcements (plan section 19): company-wide or for chosen departments, pinned, asking for acknowledgement,
 * with acknowledgement progress for publishers; who sees what, audit, database rules and notifications.
 */
const API = '/api/v1/comms/announcements';
const OWNER = 'ACV-0001'; // announcements.publish, oversight
const DIRECTOR = 'ACV-0003'; // announcements.publish, oversight
const CTO = 'ACV-0004'; // announcements.publish (no oversight), dep-eng head
const DEV1 = 'ACV-0006'; // dep-eng
const DEV2 = 'ACV-0007'; // dep-eng
const SALES1 = 'ACV-0009'; // dep-sales
const FINANCE = 'ACV-0010'; // dep-fin

let t: TestApp;
let prisma: PrismaClient;
const ids: Record<string, string> = {};
const as = (empId: string) => t.as(empId);

async function publish(who: string, body: Record<string, unknown>, status = 201) {
  const res = await as(who).post(API).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
  await t.app.get(OutboxConsumerRunner).drain(COMMS_NOTIFICATIONS_CONSUMER);
});

afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120_000);

let salesOnly = '';
let companyWide = '';

describe('publishing', () => {
  it('needs announcements.publish, a valid audience and real departments', async () => {
    const draft = { title: 'Office closed Friday', body: 'The office is closed on Friday for maintenance.', audience: { all: true, departmentIds: [] }, pinned: false, requiresAck: false };
    expect((await as(DEV1).post(API).send(draft)).status).toBe(403);
    expect((await as(SALES1).post(API).send(draft)).status).toBe(403);
    expect((await as(CTO).post(API).send({ ...draft, audience: { all: false, departmentIds: [] } })).status).toBe(400);
    expect((await as(CTO).post(API).send({ ...draft, title: 'x' })).status).toBe(400);
    const unknown = await as(CTO).post(API).send({ ...draft, audience: { all: false, departmentIds: ['dep-nowhere'] } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('unknown_department');
  });

  it('publishes to one department or to everyone, audited (never the text), and sees it in the list', async () => {
    const a = await publish(CTO, { title: 'Sales targets for December', body: 'Please read the new targets before Monday.', audience: { all: false, departmentIds: ['dep-sales'] }, pinned: false, requiresAck: true });
    salesOnly = a.id;
    expect(a).toMatchObject({ authorEmpId: CTO, audience: { all: false, departmentIds: ['dep-sales'] }, requiresAck: true, inAudience: false, acknowledgedByMe: false });
    expect(a.progress.audienceEmpIds).toContain(SALES1);
    expect(a.progress.audienceEmpIds).not.toContain(CTO);
    expect(a.progress.ackEmpIds).toEqual([]);
    const b = await publish(DIRECTOR, { title: 'Holiday calendar 2027', body: 'The holiday calendar for 2027 is now published.', audience: { all: true, departmentIds: [] }, pinned: true, requiresAck: false });
    companyWide = b.id;
    const audit = await prisma.auditLog.findMany({ where: { targetId: { in: [salesOnly, companyWide] }, action: 'comms.announcement.published' } });
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('Please read the new targets');
  });
});

describe('who sees what', () => {
  it('shows a team announcement to that team, its author and oversight only', async () => {
    expect((await as(SALES1).get(`${API}/${salesOnly}`)).status).toBe(200);
    expect((await as(CTO).get(`${API}/${salesOnly}`)).status).toBe(200);
    expect((await as(DIRECTOR).get(`${API}/${salesOnly}`)).status).toBe(200);
    expect((await as(OWNER).get(`${API}/${salesOnly}`)).status).toBe(200);
    expect((await as(DEV1).get(`${API}/${salesOnly}`)).status).toBe(404);
    expect((await as(FINANCE).get(`${API}/${salesOnly}`)).status).toBe(404);
    const devList = (await as(DEV1).get(API)).body.items.map((a: { id: string }) => a.id);
    expect(devList).toContain(companyWide);
    expect(devList).not.toContain(salesOnly);
  });

  it('lists pinned first, and gives acknowledgement progress to publishers only', async () => {
    const list = (await as(SALES1).get(API)).body.items as Array<{ id: string; pinned: boolean; progress: unknown; can: { pin: boolean } }>;
    expect(list[0].pinned).toBe(true);
    expect(list.every((a) => a.progress === null && a.can.pin === false)).toBe(true);
    const mine = (await as(SALES1).get(`${API}/${salesOnly}`)).body;
    expect(mine).toMatchObject({ inAudience: true, acknowledgedByMe: false, progress: null });
  });

  it('follows the employee records: someone moved into the department sees it, and leaves it behind when moved out', async () => {
    const move = (departmentId: string) => as(DIRECTOR).patch(`/api/v1/employees/${DEV2}/basic`).send({ departmentId, reason: 'Module 14 test: department move' });
    expect((await move('dep-sales')).status).toBe(200);
    expect((await as(DEV2).get(`${API}/${salesOnly}`)).status).toBe(200);
    expect((await move('dep-eng')).status).toBe(200);
    expect((await as(DEV2).get(`${API}/${salesOnly}`)).status).toBe(404);
  });
});

describe('acknowledging', () => {
  it('records the audience member once, refuses others, and the progress follows', async () => {
    const first = await as(SALES1).post(`${API}/${salesOnly}/ack`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.acknowledgedByMe).toBe(true);
    expect((await as(SALES1).post(`${API}/${salesOnly}/ack`)).status).toBe(200); // again: nothing changes
    expect(await prisma.announcementAck.count({ where: { announcementId: salesOnly } })).toBe(1);
    expect((await as(CTO).post(`${API}/${salesOnly}/ack`)).body.code).toBe('not_in_audience'); // the author
    expect((await as(DIRECTOR).post(`${API}/${salesOnly}/ack`)).status).toBe(403); // sees it (oversight), not addressed to him
    expect((await as(DEV1).post(`${API}/${salesOnly}/ack`)).status).toBe(404);
    expect((await as(DEV1).post(`${API}/${companyWide}/ack`)).body.code).toBe('no_ack_needed');
    const progress = (await as(CTO).get(`${API}/${salesOnly}`)).body.progress;
    expect(progress.ackEmpIds).toEqual([SALES1]);
    expect(progress.audienceEmpIds.length).toBeGreaterThan(1);
  });
});

describe('pinning', () => {
  it('is for publishers, audited', async () => {
    expect((await as(SALES1).put(`${API}/${salesOnly}/pin`)).status).toBe(403);
    const pinned = await as(DIRECTOR).put(`${API}/${salesOnly}/pin`);
    expect(pinned.status, JSON.stringify(pinned.body)).toBe(200);
    expect(pinned.body.pinned).toBe(true);
    expect((await as(SALES1).get(API)).body.items[0].id).toBe(salesOnly); // the newest pin first
    expect((await as(DIRECTOR).delete(`${API}/${salesOnly}/pin`)).body.pinned).toBe(false);
    expect(await prisma.auditLog.count({ where: { targetId: salesOnly, action: { in: ['comms.announcement.pinned', 'comms.announcement.unpinned'] } } })).toBe(2);
  });
});

describe('database rules', () => {
  it('never deletes an announcement, never changes what was announced, keeps acknowledgements', async () => {
    await expect(prisma.announcement.update({ where: { id: salesOnly }, data: { body: 'changed afterwards' } })).rejects.toThrow(/announcement_rule/);
    await expect(prisma.announcement.delete({ where: { id: salesOnly } })).rejects.toThrow(/announcement_rule/);
    await expect(prisma.announcementAck.deleteMany({ where: { announcementId: salesOnly } })).rejects.toThrow(/announcement_rule/);
    await expect(prisma.announcementAck.create({ data: { announcementId: companyWide, employeeId: ids[DEV1] } })).rejects.toThrow(/announcement_rule/);
  });
});

describe('notifications', () => {
  it('tells everyone it is for (not the author), once, with the title only', async () => {
    await t.app.get(OutboxConsumerRunner).drain(COMMS_NOTIFICATIONS_CONSUMER);
    const sales = await prisma.notification.findMany({ where: { dedupeKey: `comms:announcement:${salesOnly}` }, select: { recipientId: true, title: true, body: true, type: true } });
    const recipients = sales.map((n) => n.recipientId);
    expect(recipients).toContain(ids[SALES1]);
    expect(recipients).not.toContain(ids[CTO]);
    expect(recipients).not.toContain(ids[DEV1]);
    expect(sales[0]).toMatchObject({ type: 'announcement', title: 'Please read and acknowledge: Sales targets for December', body: null });
    const all = await prisma.notification.count({ where: { dedupeKey: `comms:announcement:${companyWide}` } });
    const active = await prisma.employee.count({ where: { status: { not: 'left' } } });
    expect(all).toBe(active - 1);
    await t.app.get(OutboxConsumerRunner).drain(COMMS_NOTIFICATIONS_CONSUMER);
    expect(await prisma.notification.count({ where: { dedupeKey: `comms:announcement:${companyWide}` } })).toBe(all);
  });
});
