import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { OutboxConsumerRunner } from '../src/events/outbox-consumer-runner.service';
import { OutboxService } from '../src/events/outbox.service';
import { MAX_EMAIL_ATTEMPTS, NotificationDeliveryService, SENDING_STALE_MS } from '../src/notifications/notification-delivery.service';
import { NOTIFICATIONS_CONSUMER } from '../src/notifications/notification-events.consumer';
import { createTestApp, type SignedIn, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/** Cycle 3 foundation: the minimal Module 12 notification core and the module-owned settings pattern. */
const API = '/api/v1';
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const FINANCE = 'ACV-0010';
let CEO = '';

let t: TestApp;
let prisma: PrismaClient;
let runner: OutboxConsumerRunner;
let outbox: OutboxService;
let delivery: NotificationDeliveryService;
const emails: Record<string, string> = {};
const ids: Record<string, string> = {};

const process = () => runner.drain(NOTIFICATIONS_CONSUMER);
const put = (who: string, url: string) => request(t.app.getHttpServer()).put(url).set((t.as(who) as SignedIn).headers());
const mine = async (who: string) => (await t.as(who).get(`${API}/notifications`).expect(200)).body as Array<{ id: string; type: string; title: string; read: boolean; essential: boolean; link: string | null }>;
const sentTo = (empId: string) => t.mailer.sent.filter((m) => m.to.toLowerCase() === emails[empId].toLowerCase());
const deliveryOf = async (empId: string, type: string) =>
  prisma.notificationDelivery.findFirstOrThrow({ where: { notification: { recipientId: ids[empId], type } }, orderBy: { createdAt: 'desc' } });

async function leaveRequested(requestNumber: string, from = DEV1, approver = DIRECTOR) {
  await outbox.emit({ type: 'leave.requested', actor: from, payload: { requestNumber, empId: from, approverEmpId: approver, from: '2030-01-10', to: '2030-01-11' } });
}

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  CEO = OWNER; // final company structure (main): the CEO, Founder and Owner are one person, ACV-0001
  prisma = createTestPrisma();
  runner = t.app.get(OutboxConsumerRunner);
  outbox = t.app.get(OutboxService);
  delivery = t.app.get(NotificationDeliveryService);
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true, officialEmail: true } })) {
    ids[e.empId] = e.id;
    if (e.officialEmail) emails[e.empId] = e.officialEmail;
  }
  await process(); // the reader starts here: everything the sign-ins wrote before is not replayed
}, 180000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);
beforeEach(() => {
  t.mailer.failing = false;
});

describe('Cycle 3 foundation: notifications from existing events', () => {
  it('a leave request notifies its approver once, in the app and by email; running everything again adds nothing', async () => {
    await leaveRequested('LR-T-0001');
    expect((await process())[NOTIFICATIONS_CONSUMER]).toMatchObject({ done: 1 });
    const list = await mine(DIRECTOR);
    const n = list.find((x) => x.title === 'A leave request is waiting for your approval')!;
    expect(n).toMatchObject({ type: 'leave_requested', essential: true, read: false, link: '/approvals' });
    expect(await mine(DEV1)).toHaveLength(0); // nobody is told about their own request

    expect(await delivery.drain()).toMatchObject({ sent: 1 });
    const mail = sentTo(DIRECTOR);
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe('[Aceva] A leave request is waiting for your approval');
    expect(mail[0].text).toContain('LR-T-0001');
    expect(mail[0].text).toContain('/approvals');
    expect(mail[0].text).toContain('cannot be turned off');

    // retries of every stage: no second notification, no second email
    await process();
    await delivery.drain();
    expect((await mine(DIRECTOR)).filter((x) => x.type === 'leave_requested')).toHaveLength(1);
    expect(sentTo(DIRECTOR)).toHaveLength(1);
    expect(await prisma.notificationDelivery.count({ where: { notification: { recipientId: ids[DIRECTOR] } } })).toBe(1);
  });

  it('the same event processed by a retried reader cannot create a second notification (unique per recipient and event)', async () => {
    await leaveRequested('LR-T-0002');
    await process();
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'leave.requested', payload: { path: ['requestNumber'], equals: 'LR-T-0002' } } });
    // simulate a reader that crashed after notifying but before recording its progress: run the handler again
    await prisma.outboxConsumption.delete({ where: { consumer_eventId: { consumer: NOTIFICATIONS_CONSUMER, eventId: event.id } } });
    await process();
    expect(await prisma.notification.count({ where: { sourceEventId: event.id } })).toBe(1);
    expect(await prisma.notificationDelivery.count({ where: { notification: { sourceEventId: event.id } } })).toBe(1);
    await delivery.drain();
  });

  it('a decision notifies the requester; a cancellation and the decider\'s own action notify nobody', async () => {
    await outbox.emit({ type: 'leave.decided', actor: DIRECTOR, payload: { requestNumber: 'LR-T-0001', empId: DEV1, decision: 'approved', byEmpId: DIRECTOR, nextApproverEmpId: null } });
    await outbox.emit({ type: 'leave.decided', actor: DEV2, payload: { requestNumber: 'LR-T-0003', empId: DEV2, decision: 'cancelled', byEmpId: DEV2, nextApproverEmpId: null } });
    await outbox.emit({ type: 'attendance.correction.decided', actor: DIRECTOR, payload: { correctionId: '00000000-0000-4000-8000-000000000001', empId: DEV1, date: '2030-01-09', decision: 'rejected', byEmpId: DIRECTOR } });
    await process();
    const dev1 = await mine(DEV1);
    expect(dev1.map((n) => n.title).sort()).toEqual(['Your attendance correction for 2030-01-09 was rejected', 'Your leave request LR-T-0001 was approved']);
    expect(dev1.every((n) => !n.essential)).toBe(true);
    expect(await mine(DEV2)).toHaveLength(0);
    await delivery.drain();
  });

  it('payroll ready (prepared by Finance) goes to the Director only, never to the preparer or the Owner; a payslip to its employee', async () => {
    await outbox.emit({ type: 'payroll.run.ready', actor: FINANCE, payload: { runNumber: 'PR-2030-01', month: '2030-01', stage: 'prepared' } });
    await outbox.emit({ type: 'payslip.issued', actor: DIRECTOR, payload: { empId: DIRECTOR, month: '2030-01' } });
    await process();
    const director = await mine(DIRECTOR);
    expect(director.find((n) => n.type === 'payroll_ready')).toMatchObject({ title: 'PR-2030-01 payroll is ready for your approval', link: '/payroll/runs/PR-2030-01', essential: true });
    expect(director.find((n) => n.type === 'payslip_available')).toBeTruthy(); // their own payslip, although they caused the event
    expect((await mine(FINANCE)).filter((n) => n.type === 'payroll_ready')).toHaveLength(0);
    // D26: the Owner decides only a run the Director prepared, so is not asked about this one
    expect((await mine(OWNER)).filter((n) => n.type === 'payroll_ready')).toHaveLength(0);
    await delivery.drain();
  });

  it('payroll ready (prepared by the Director) goes to the Owner only (D26), never back to the Director', async () => {
    await outbox.emit({ type: 'payroll.run.ready', actor: DIRECTOR, payload: { runNumber: 'PR-2030-02', month: '2030-02', stage: 'prepared' } });
    await process();
    expect((await mine(OWNER)).find((n) => n.type === 'payroll_ready' && n.title.startsWith('PR-2030-02'))).toMatchObject({
      title: 'PR-2030-02 payroll is ready for your approval',
      link: '/payroll/runs/PR-2030-02',
      essential: true,
    });
    expect((await mine(DIRECTOR)).filter((n) => n.type === 'payroll_ready' && n.title.startsWith('PR-2030-02'))).toHaveLength(0);
    expect((await mine(FINANCE)).filter((n) => n.type === 'payroll_ready' && n.title.startsWith('PR-2030-02'))).toHaveLength(0);
    await delivery.drain();
  });

  it('a reopened finance month is a security alert to the Owner, CEO and Director, except the person who reopened it', async () => {
    await outbox.emit({ type: 'finance.period.reopened', actor: DIRECTOR, payload: { month: '2030-01', byEmpId: DIRECTOR, reason: 'Auditor adjustment' } });
    await process();
    for (const who of [OWNER, CEO]) {
      const alert = (await mine(who)).find((n) => n.type === 'security_alert')!;
      expect(alert).toMatchObject({ title: 'Finance month 2030-01 was reopened', essential: true });
    }
    expect((await mine(DIRECTOR)).filter((n) => n.type === 'security_alert')).toHaveLength(0);
    await delivery.drain();
  });
});

describe('Cycle 3 foundation: reading notifications and email choices', () => {
  it('each person reads and marks only their own notifications; others cannot see or mark them', async () => {
    const own = await mine(DEV1);
    expect(own.length).toBeGreaterThan(0);
    const unread = (await t.as(DEV1).get(`${API}/notifications?unread=true`).expect(200)).body;
    expect(unread.length).toBe(own.filter((n) => !n.read).length);
    // DEV2 tries to mark DEV1's notification read: nothing of DEV1's changes
    expect((await t.as(DEV2).post(`${API}/notifications/read`).send({ ids: [own[0].id] }).expect(200)).body).toEqual({ updated: 0 });
    expect((await mine(DEV1)).find((n) => n.id === own[0].id)!.read).toBe(false);
    expect((await t.as(DEV1).post(`${API}/notifications/read`).send({ ids: [own[0].id] }).expect(200)).body).toEqual({ updated: 1 });
    expect((await t.as(DEV1).post(`${API}/notifications/read`).send({}).expect(200)).body.updated).toBe(own.length - 1);
    expect((await t.as(DEV1).get(`${API}/notifications?unread=true`).expect(200)).body).toHaveLength(0);
    await t.as(DEV1).post(`${API}/notifications/read`).send({ ids: ['not-a-uuid'] }).expect(400);
    await t.anonymous().get(`${API}/notifications`).expect(401);
  });

  it('a person can turn off non-essential emails; the notification still appears in the app', async () => {
    expect((await t.as(DEV1).get(`${API}/notifications/prefs`).expect(200)).body).toEqual({ email: {}, dailySummary: true });
    const saved = (await t.as(DEV1).patch(`${API}/notifications/prefs`).send({ email: { payslip_available: false, leave_answered: true }, dailySummary: false }).expect(200)).body;
    expect(saved).toEqual({ email: { payslip_available: false }, dailySummary: false });
    expect(await prisma.auditLog.count({ where: { action: 'notifications.prefs.changed', targetId: DEV1 } })).toBe(1);

    t.mailer.clear();
    await outbox.emit({ type: 'payslip.issued', actor: DIRECTOR, payload: { empId: DEV1, month: '2030-02' } });
    await process();
    expect((await mine(DEV1)).find((n) => n.title === 'Your payslip for 2030-02 is available')).toBeTruthy();
    expect(await deliveryOf(DEV1, 'payslip_available')).toMatchObject({ status: 'skipped', note: 'turned_off' });
    await delivery.drain();
    expect(sentTo(DEV1)).toHaveLength(0);
  });

  it('approvals and security alerts can never be turned off: refused by the API and by the database', async () => {
    for (const type of ['leave_requested', 'approval_waiting', 'payroll_ready', 'extension_requested', 'security_alert']) {
      const res = await t.as(DIRECTOR).patch(`${API}/notifications/prefs`).send({ email: { [type]: false }, dailySummary: true }).expect(400);
      expect(res.body.code).toBe('essential_notification');
    }
    await t.as(DIRECTOR).patch(`${API}/notifications/prefs`).send({ email: { not_a_type: false }, dailySummary: true }).expect(400);
    await expect(prisma.notificationPreference.upsert({ where: { employeeId: ids[DIRECTOR] }, create: { employeeId: ids[DIRECTOR], emailOff: ['security_alert'] }, update: { emailOff: ['security_alert'] } })).rejects.toThrow(/essential_always_emailed|check constraint/i);
    // even a stored preference cannot stop an essential email: it is never consulted for those types
    await leaveRequested('LR-T-0004', DEV2);
    await process();
    expect(await deliveryOf(DIRECTOR, 'leave_requested')).toMatchObject({ status: 'pending' });
    await delivery.drain();
  });
});

describe('Cycle 3 foundation: email delivery', () => {
  it('a failed send is retried later with a growing delay and sent exactly once', async () => {
    t.mailer.clear();
    await leaveRequested('LR-T-0005', DEV2);
    await process();
    t.mailer.failing = true;
    expect(await delivery.drain()).toMatchObject({ retrying: 1, sent: 0 });
    expect(await deliveryOf(DIRECTOR, 'leave_requested')).toMatchObject({ status: 'pending', attempts: 1 });
    t.mailer.failing = false;
    expect(await delivery.drain()).toMatchObject({ sent: 0 }); // not before the retry time
    t.clock.advance(61_000);
    expect(await delivery.drain()).toMatchObject({ sent: 1 });
    expect(await deliveryOf(DIRECTOR, 'leave_requested')).toMatchObject({ status: 'sent', attempts: 2 });
    await delivery.drain();
    expect(sentTo(DIRECTOR).filter((m) => m.text.includes('LR-T-0005'))).toHaveLength(1);
  });

  it(`gives up after ${MAX_EMAIL_ATTEMPTS} failed attempts (the in-app notification stays)`, async () => {
    await leaveRequested('LR-T-0006', DEV2);
    await process();
    t.mailer.failing = true;
    for (let i = 0; i < MAX_EMAIL_ATTEMPTS; i++) {
      await delivery.drain();
      t.clock.advance(3 * 3600_000);
    }
    const d = await deliveryOf(DIRECTOR, 'leave_requested');
    expect(d).toMatchObject({ status: 'failed', attempts: MAX_EMAIL_ATTEMPTS });
    expect(d.note).toMatch(/Mail server unreachable/);
    t.mailer.failing = false;
    await delivery.drain();
    expect(sentTo(DIRECTOR).filter((m) => m.text.includes('LR-T-0006'))).toHaveLength(0);
  });

  it('a send interrupted half-way is marked unknown and never sent again automatically (no duplicate email)', async () => {
    await leaveRequested('LR-T-0007', DEV2);
    await process();
    const d = await deliveryOf(DIRECTOR, 'leave_requested');
    await prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'sending', claimedAt: t.clock.now(), attempts: 1 } });
    t.clock.advance(SENDING_STALE_MS + 1_000);
    await delivery.drain();
    expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'unknown' });
    expect(sentTo(DIRECTOR).filter((m) => m.text.includes('LR-T-0007'))).toHaveLength(0);
  });
});

describe('Cycle 3 foundation: module-owned settings (notifications)', () => {
  beforeAll(async () => {
    await t.signInAll(); // the email tests above moved the clock on by hours: sessions have timed out
  }, 180000);

  it('the defaults read as version 0; only settings.manage changes them, with a reason, the version read and a valid value', async () => {
    const view = (await t.as(DIRECTOR).get(`${API}/settings/modules/notifications`).expect(200)).body;
    expect(view).toEqual({ module: 'notifications', value: { emailEnabled: true }, version: 0, updatedAt: null, updatedByEmpId: null });
    await t.as(DEV1).get(`${API}/settings/modules/notifications`).expect(404); // no settings.view
    await t.as(DIRECTOR).get(`${API}/settings/modules/unknown_module`).expect(404);
    await t.as(DIRECTOR).get(`${API}/settings/modules/Bad-Key`).expect(400);

    const change = { value: { emailEnabled: false }, version: 0, reason: 'Mail server maintenance tonight' };
    await put(DEV1, `${API}/settings/modules/notifications`).send(change).expect(404);
    expect((await put(CEO, `${API}/settings/modules/notifications`).send(change).expect(403)).body.code).toBe('forbidden'); // settings.view, no settings.manage
    expect((await put(DIRECTOR, `${API}/settings/modules/notifications`).send({ ...change, value: { emailEnabled: 'no' } }).expect(400)).body.code).toBe('invalid_settings');
    expect((await put(DIRECTOR, `${API}/settings/modules/notifications`).send({ ...change, value: { emailEnabled: false, extra: 1 } }).expect(400)).body.code).toBe('invalid_settings');
    await put(DIRECTOR, `${API}/settings/modules/notifications`).send({ ...change, reason: 'x' }).expect(400);

    const saved = (await put(DIRECTOR, `${API}/settings/modules/notifications`).send(change).expect(200)).body;
    expect(saved).toMatchObject({ value: { emailEnabled: false }, version: 1, updatedByEmpId: DIRECTOR });
    expect((await put(DIRECTOR, `${API}/settings/modules/notifications`).send(change).expect(409)).body.code).toBe('stale_version');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'settings.module.changed', targetId: 'notifications' } });
    expect(audit).toMatchObject({ reason: change.reason, details: { before: { emailEnabled: true }, after: { emailEnabled: false } } });
  });

  it('with notification emails switched off company-wide, emails wait (nothing is dropped) and go out once switched on', async () => {
    t.mailer.clear();
    await leaveRequested('LR-T-0008', DEV2);
    await process();
    expect(await delivery.drain()).toMatchObject({ sent: 0, held: 1 });
    expect(sentTo(DIRECTOR)).toHaveLength(0);
    await put(DIRECTOR, `${API}/settings/modules/notifications`).send({ value: { emailEnabled: true }, version: 1, reason: 'Mail server is back' }).expect(200);
    expect(await delivery.drain()).toMatchObject({ sent: 1, held: 0 });
    expect(sentTo(DIRECTOR)).toHaveLength(1);
  });
});
