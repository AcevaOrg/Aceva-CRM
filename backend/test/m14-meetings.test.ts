import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMS_NOTIFICATIONS_CONSUMER } from '../src/comms/comms-notifications.consumer';
import { OutboxConsumerRunner } from '../src/events/outbox-consumer-runner.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 14 meetings (plan section 19): create, invite, date and time, agenda, notes, RSVP and cancel; private to the
 * organizer and invitees; audited without the agenda or notes; database rules; invitation and cancellation notifications.
 */
const API = '/api/v1/comms/meetings';
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const DEV1 = 'ACV-0006'; // organizer
const DEV2 = 'ACV-0007';
const DEV3 = 'ACV-0008';
const SALES1 = 'ACV-0009';
const PRIVATE = 'Agenda item about a private salary matter';

let t: TestApp;
let prisma: PrismaClient;
const ids: Record<string, string> = {};
const as = (empId: string) => t.as(empId);
const inHours = (h: number) => new Date(t.clock.now().getTime() + h * 3_600_000).toISOString();

let meeting = '';

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
  await t.app.get(OutboxConsumerRunner).drain(COMMS_NOTIFICATIONS_CONSUMER);
});

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120_000);

describe('creating', () => {
  it('needs a future time, a real place and current colleagues; the organizer is never an invitee', async () => {
    const base = { title: 'Sprint review', startsAt: inHours(24), durationMin: 30, location: 'Dadu HQ · meeting room', agenda: PRIVATE, participantEmpIds: [DEV2, DEV3] };
    expect((await as(DEV1).post(API).send({ ...base, startsAt: inHours(-2) })).body.code).toBe('in_the_past');
    expect((await as(DEV1).post(API).send({ ...base, participantEmpIds: [DEV1] })).body.code).toBe('no_participants');
    expect((await as(DEV1).post(API).send({ ...base, participantEmpIds: ['ACV-9999'] })).body.code).toBe('not_current_employee');
    expect((await as(DEV1).post(API).send({ ...base, durationMin: 2 })).status).toBe(400);
    const res = await as(DEV1).post(API).send({ ...base, participantEmpIds: [DEV2, DEV3, DEV1] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    meeting = res.body.id;
    expect(res.body).toMatchObject({ organizerEmpId: DEV1, agenda: PRIVATE, cancelled: false, can: { edit: true, invite: true, cancel: true, rsvp: false } });
    expect(res.body.participants.map((p: { empId: string; rsvp: string }) => [p.empId, p.rsvp])).toEqual([
      [DEV2, 'pending'],
      [DEV3, 'pending'],
    ]);
  });
});

describe('privacy', () => {
  it('is visible to the organizer and invitees only, never to managers or admins', async () => {
    for (const who of [DEV1, DEV2, DEV3]) expect((await as(who).get(`${API}/${meeting}`)).status).toBe(200);
    for (const who of [SALES1, DIRECTOR, OWNER]) {
      expect((await as(who).get(`${API}/${meeting}`)).status).toBe(404);
      expect((await as(who).put(`${API}/${meeting}/rsvp`).send({ rsvp: 'yes' })).status).toBe(404);
      expect(((await as(who).get(API)).body as Array<{ id: string }>).map((m) => m.id)).not.toContain(meeting);
    }
    expect(((await as(DEV2).get(API)).body as Array<{ id: string }>).map((m) => m.id)).toContain(meeting);
  });

  it('audits every change without the agenda or notes text', async () => {
    const audit = await prisma.auditLog.findMany({ where: { targetId: meeting } });
    expect(audit.map((a) => a.action)).toContain('comms.meeting.created');
    expect(JSON.stringify(audit)).not.toContain(PRIVATE);
  });
});

describe('answers, notes and changes', () => {
  it('lets invitees answer, and only the organizer change the meeting, invite people and write notes', async () => {
    const yes = await as(DEV2).put(`${API}/${meeting}/rsvp`).send({ rsvp: 'yes' });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    expect(yes.body.participants.find((p: { empId: string }) => p.empId === DEV2).rsvp).toBe('yes');
    expect((await as(DEV3).put(`${API}/${meeting}/rsvp`).send({ rsvp: 'maybe' })).status).toBe(200);
    expect((await as(DEV1).put(`${API}/${meeting}/rsvp`).send({ rsvp: 'yes' })).body.code).toBe('organizer');
    expect((await as(DEV2).put(`${API}/${meeting}/rsvp`).send({ rsvp: 'later' })).status).toBe(400);

    expect((await as(DEV2).patch(`${API}/${meeting}`).send({ notes: 'Not mine to write' })).body.code).toBe('organizer_only');
    expect((await as(DEV2).post(`${API}/${meeting}/participants`).send({ empIds: [SALES1] })).body.code).toBe('organizer_only');
    const notes = await as(DEV1).patch(`${API}/${meeting}`).send({ notes: `Decided: ship on Friday. ${PRIVATE}`, durationMin: 45 });
    expect(notes.status, JSON.stringify(notes.body)).toBe(200);
    expect(notes.body).toMatchObject({ durationMin: 45, notes: `Decided: ship on Friday. ${PRIVATE}` });
    expect(notes.body.notesUpdatedAt).toBeTruthy();
    expect((await as(DEV3).get(`${API}/${meeting}`)).body.notes).toContain('ship on Friday');

    const invited = await as(DEV1).post(`${API}/${meeting}/participants`).send({ empIds: [SALES1, DEV2] });
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
    expect(invited.body.participants.map((p: { empId: string }) => p.empId)).toEqual([DEV2, DEV3, SALES1]);
    expect((await as(SALES1).get(`${API}/${meeting}`)).status).toBe(200);
    const audit = await prisma.auditLog.findMany({ where: { targetId: meeting } });
    expect(JSON.stringify(audit)).not.toContain(PRIVATE);
  });

  it('refuses answers after the meeting is over', async () => {
    // A meeting held two hours ago, written straight into the database (moving the clock by hours would end every session).
    const short = await prisma.meeting.create({
      data: { title: 'Quick sync', startsAt: new Date(t.clock.now().getTime() - 2 * 3_600_000), durationMin: 15, location: 'Video call', organizerId: ids[DEV1], participants: { create: { employeeId: ids[DEV2], invitedById: ids[DEV1] } } },
    });
    expect((await as(DEV2).put(`${API}/${short.id}/rsvp`).send({ rsvp: 'yes' })).body.code).toBe('meeting_over');
    expect((await as(DEV2).get(`${API}/${short.id}`)).body.can.rsvp).toBe(false);
  });
});

describe('cancelling', () => {
  it('is for the organizer, with a reason (audited); the meeting stays, read-only', async () => {
    expect((await as(DEV2).post(`${API}/${meeting}/cancel`).send({ reason: 'I cannot cancel this' })).body.code).toBe('organizer_only');
    expect((await as(DEV1).post(`${API}/${meeting}/cancel`).send({ reason: 'no' })).status).toBe(400);
    const res = await as(DEV1).post(`${API}/${meeting}/cancel`).send({ reason: 'The review moved to next week' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ cancelled: true, can: { edit: false, rsvp: false, cancel: false, invite: false } });
    expect((await as(DEV2).put(`${API}/${meeting}/rsvp`).send({ rsvp: 'no' })).body.code).toBe('meeting_cancelled');
    expect((await as(DEV1).patch(`${API}/${meeting}`).send({ agenda: 'late change' })).body.code).toBe('meeting_cancelled');
    expect((await as(DEV2).get(`${API}/${meeting}`)).status).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { targetId: meeting, action: 'comms.meeting.cancelled' } });
    expect(audit?.reason).toBe('The review moved to next week');
  });
});

describe('database rules', () => {
  it('never deletes a meeting or an invitation, never changes a cancelled meeting or its organizer', async () => {
    await expect(prisma.meeting.delete({ where: { id: meeting } })).rejects.toThrow(/meeting_rule/);
    await expect(prisma.meetingParticipant.deleteMany({ where: { meetingId: meeting } })).rejects.toThrow(/meeting_rule/);
    await expect(prisma.meeting.update({ where: { id: meeting }, data: { title: 'Changed after cancelling' } })).rejects.toThrow(/meeting_rule/);
    const open = (await as(DEV1).post(API).send({ title: 'Planning', startsAt: inHours(48), durationMin: 30, location: 'Video call', participantEmpIds: [DEV2] })).body;
    await expect(prisma.meeting.update({ where: { id: open.id }, data: { organizerId: ids[DEV2] } })).rejects.toThrow(/meeting_rule/);
    await expect(prisma.meetingParticipant.create({ data: { meetingId: open.id, employeeId: ids[DEV1], invitedById: ids[DEV1] } })).rejects.toThrow(/meeting_rule/);
  });
});

describe('notifications', () => {
  it('invites and cancellations reach the people invited, with the time only (never the title or agenda)', async () => {
    await t.app.get(OutboxConsumerRunner).drain(COMMS_NOTIFICATIONS_CONSUMER);
    const about = await prisma.notification.findMany({ where: { link: `/meetings/${meeting}` }, select: { recipientId: true, type: true, title: true, body: true } });
    const invited = about.filter((n) => n.type === 'meeting_invited').map((n) => n.recipientId).sort();
    expect(invited).toEqual([ids[DEV2], ids[DEV3], ids[SALES1]].sort());
    const cancelledFor = about.filter((n) => n.type === 'meeting_cancelled').map((n) => n.recipientId).sort();
    expect(cancelledFor).toEqual([ids[DEV2], ids[DEV3], ids[SALES1]].sort());
    expect(about.some((n) => n.recipientId === ids[DEV1])).toBe(false);
    expect(about.find((n) => n.type === 'meeting_invited')?.title).toMatch(/^Fahad Khan invited you to a meeting on \d+ \w+, \d\d:\d\d$/);
    expect(JSON.stringify(about)).not.toContain('Sprint review');
    expect(JSON.stringify(about)).not.toContain(PRIVATE);
  });
});
