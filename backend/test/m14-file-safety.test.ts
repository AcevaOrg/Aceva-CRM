import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMS_UNSENT_FILE_GRACE_HOURS, COMMS_UPLOADS_PER_MINUTE } from '@aceva/contracts';
import type { Actor } from '../src/access/access.types';
import { COMMS_FILE_SCAN_JOB, CommsFileService } from '../src/comms/comms-file.service';
import { CommsFileMaintenance, RESCAN_REARM_AFTER_MS } from '../src/comms/comms-file-maintenance.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { JobRunner } from '../src/jobs/job-runner.service';
import { FILE_STORAGE, type FileStorage } from '../src/storage/file-storage';
import { MALWARE_SCANNER, type MalwareScanner, type ScanResult } from '../src/storage/malware-scanner';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 14 file safety (the review of file sharing): the per-person upload limit; recovery of files whose scan job gave
 * up after its five attempts; discarding files uploaded but never sent (never a sent file or a meeting file); races
 * between sends, and between a send and the discard; a comms admin who only manages a channel gets nothing of its files.
 */
const API = '/api/v1/comms';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004'; // comms.admin, not a member of the Director's channel below
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const DEV3 = 'ACV-0008';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

let verdict: ScanResult = { verdict: 'clean' };
const scanner: MalwareScanner = { scan: async () => verdict };

let t: TestApp;
let prisma: PrismaClient;
let storage: FileStorage;
const ids: Record<string, string> = {};
const as = (empId: string) => t.as(empId);
const conv = (id: string) => `${API}/conversations/${id}`;

async function actorOf(empId: string): Promise<Actor> {
  const e = await prisma.employee.findUniqueOrThrow({ where: { empId }, select: { id: true, empId: true, fullName: true, level: { select: { number: true } }, role: { select: { key: true } } } });
  return { id: e.id, empId: e.empId, fullName: e.fullName, levelNumber: e.level.number, roleKey: e.role.key };
}

async function upload(who: string, path: string, status = 201) {
  const res = await as(who).post(path).attach('file', PDF, 'file.pdf');
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}

let group = '';
let channel = '';
// Files made over HTTP before the clock is moved (moving it by hours ends every session).
let unsent = '';
let sent = '';
let meetingFile = '';
let stuck = '';

beforeAll(async () => {
  t = await createTestApp({ overrides: [{ provide: MALWARE_SCANNER, useValue: scanner }] });
  await t.signInAll();
  prisma = createTestPrisma();
  storage = t.app.get(FILE_STORAGE);
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
  group = (await as(DEV1).post(`${API}/conversations`).send({ kind: 'group', name: 'File safety', memberEmpIds: [DEV2] })).body.conversation.id;
  channel = (await as(DIRECTOR).post(`${API}/conversations`).send({ kind: 'channel', scope: 'project', name: 'safety-channel', projectName: 'Safety', memberEmpIds: [DEV1] })).body.conversation.id;
});

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120_000);

describe('the upload limit', () => {
  it('allows at most COMMS_UPLOADS_PER_MINUTE uploads a minute per person, then answers 429 with when to retry', async () => {
    for (let i = 0; i < COMMS_UPLOADS_PER_MINUTE; i++) await upload(DEV2, `${conv(group)}/files`);
    const refused = await as(DEV2).post(`${conv(group)}/files`).attach('file', PDF, 'one-more.pdf');
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('rate_limited');
    expect(refused.body.retryAfterSec).toBeGreaterThan(0);
    // Someone else is not limited by DEV2's uploads; DEV2 can upload again in the next minute.
    await upload(DEV1, `${conv(group)}/files`);
    t.clock.advance(61_000);
    await upload(DEV2, `${conv(group)}/files`);
  });
});

describe('a comms admin who only manages a channel', () => {
  it('can neither upload to it nor see or download its files', async () => {
    const file = await upload(DEV1, `${conv(channel)}/files`);
    const msg = await as(DEV1).post(`${conv(channel)}/messages`).send({ clientKey: randomUUID(), body: 'Channel file', attachmentIds: [file.id] });
    expect(msg.status, JSON.stringify(msg.body)).toBe(201);
    expect((await as(CTO).get(`${conv(channel)}`)).status).toBe(200); // may manage it
    await upload(CTO, `${conv(channel)}/files`, 404);
    expect((await as(CTO).get(`${API}/files/${file.id}`)).status).toBe(404);
    expect((await as(CTO).get(`${API}/files/${file.id}/download`)).status).toBe(404);
    expect((await as(DIRECTOR).get(`${API}/files/${file.id}/download`)).status).toBe(200); // a member
  });
});

describe('two sends with the same file at the same moment', () => {
  it('attach it once: one send succeeds, the other is refused and saves nothing', async () => {
    t.clock.advance(61_000);
    const file = await upload(DEV1, `${conv(group)}/files`);
    const before = await prisma.message.count({ where: { conversationId: group } });
    const results = await Promise.all(
      [1, 2].map((n) => as(DEV1).post(`${conv(group)}/messages`).send({ clientKey: randomUUID(), body: `Race ${n}`, attachmentIds: [file.id] })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(results.find((r) => r.status === 400)!.body.code).toBe('invalid_attachments');
    expect(await prisma.message.count({ where: { conversationId: group } })).toBe(before + 1);
    const row = await prisma.commsFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.messageId).toBe(results.find((r) => r.status === 201)!.body.message.id);
  });
});

describe('files made before the clock moves', () => {
  it('sets up an unsent file, a sent one, a meeting file and one stuck in scanning', async () => {
    t.clock.advance(61_000);
    unsent = (await upload(DEV1, `${conv(group)}/files`)).id;
    const s = await upload(DEV1, `${conv(group)}/files`);
    expect((await as(DEV1).post(`${conv(group)}/messages`).send({ clientKey: randomUUID(), body: 'Sent with its file', attachmentIds: [s.id] })).status).toBe(201);
    sent = s.id;
    const meeting = (
      await as(DEV1).post(`${API}/meetings`).send({ title: 'Safety review', startsAt: new Date(t.clock.now().getTime() + 86_400_000).toISOString(), durationMin: 30, location: 'Video call', participantEmpIds: [DEV3] })
    ).body;
    meetingFile = (await upload(DEV1, `${API}/meetings/${meeting.id}/files`)).id;
    verdict = { verdict: 'unavailable', reason: 'ECONNREFUSED' };
    const s2 = await upload(DEV1, `${conv(group)}/files`);
    expect(s2.scan).toBe('scanning');
    stuck = s2.id;
  });
});

describe('a scan that keeps failing', () => {
  it('stays closed through all five job attempts, then the sweep arms it again; once the scanner answers it opens', async () => {
    const runner = t.app.get(JobRunner);
    const key = `${COMMS_FILE_SCAN_JOB}:${stuck}`;
    // The five attempts, each after its back-off (1 minute, 5 minutes, 30 minutes, 2 hours).
    for (const wait of [61_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000]) {
      t.clock.advance(wait + 1_000);
      await runner.tick();
    }
    const job = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: key } });
    expect(job).toMatchObject({ status: 'failed', attempts: 5 });
    expect((await prisma.commsFile.findUniqueOrThrow({ where: { id: stuck } })).scanStatus).toBe('scanning');
    const files = t.app.get(CommsFileService);
    // Not sent yet, so only its uploader may ask for it; even they cannot open it while it is unchecked.
    await expect(files.download(await actorOf(DEV1), stuck, {} as never)).rejects.toMatchObject({ response: { code: 'file_scanning' } });

    // Failed just now: the sweep waits (it re-arms at most once per RESCAN_REARM_AFTER_MS).
    const maintenance = t.app.get(CommsFileMaintenance);
    expect((await maintenance.sweep()).rearmed).toBe(0);
    t.clock.advance(RESCAN_REARM_AFTER_MS + 1_000);
    const swept = await maintenance.sweep();
    expect(swept.rearmed).toBe(1);
    expect(await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: key } })).toMatchObject({ status: 'pending', attempts: 0 });

    verdict = { verdict: 'clean' };
    await runner.tick();
    expect((await prisma.commsFile.findUniqueOrThrow({ where: { id: stuck } })).scanStatus).toBe('clean');
    expect((await maintenance.sweep()).rearmed).toBe(0); // nothing stuck any more
  });
});

describe('files uploaded but never sent', () => {
  it(`are discarded after ${COMMS_UNSENT_FILE_GRACE_HOURS} hours (record kept, bytes removed); sent and meeting files are never touched`, async () => {
    // Past the grace period (counted from the uploads, made before the clock moved).
    t.clock.advance(COMMS_UNSENT_FILE_GRACE_HOURS * 3_600_000);
    const row = (id: string) => prisma.commsFile.findUniqueOrThrow({ where: { id } });
    const keys = { unsent: (await row(unsent)).storageKey, sent: (await row(sent)).storageKey, meeting: (await row(meetingFile)).storageKey };
    expect(await storage.exists(keys.unsent)).toBe(true);
    const result = await t.app.get(CommsFileMaintenance).sweep();
    expect(result.discarded).toBeGreaterThanOrEqual(1);
    expect((await row(unsent)).discardedAt).not.toBeNull();
    expect(await storage.exists(keys.unsent)).toBe(false);
    expect((await row(sent)).discardedAt).toBeNull();
    expect(await storage.exists(keys.sent)).toBe(true);
    expect((await row(meetingFile)).discardedAt).toBeNull();
    expect(await storage.exists(keys.meeting)).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'comms.file.discarded', targetId: unsent } })).toBe(1);
    // Running again changes nothing.
    expect((await t.app.get(CommsFileMaintenance).sweep()).discarded).toBe(0);

    // A discarded file can no longer be sent or opened.
    const files = t.app.get(CommsFileService);
    const dev1 = await actorOf(DEV1);
    await expect(files.checkAttachable(dev1, group, [unsent])).rejects.toMatchObject({ response: { code: 'invalid_attachments' } });
    await expect(files.download(dev1, unsent, {} as never)).rejects.toMatchObject({ response: { code: 'file_discarded' } });
    expect((await files.view(dev1, unsent)).discarded).toBe(true);
  });

  it('race with a send is decided by the database: a discarded file is never attached, an attached one never discarded', async () => {
    const message = await prisma.message.findFirstOrThrow({ where: { conversationId: group, deletedAt: null }, orderBy: { seq: 'desc' } });
    await expect(prisma.commsFile.update({ where: { id: unsent }, data: { messageId: message.id } })).rejects.toThrow(/attachment_rule/);
    await expect(prisma.commsFile.update({ where: { id: unsent }, data: { discardedAt: null } })).rejects.toThrow(/attachment_rule/);
    await expect(prisma.commsFile.update({ where: { id: sent }, data: { discardedAt: new Date() } })).rejects.toThrow();
    await expect(prisma.commsFile.update({ where: { id: meetingFile }, data: { discardedAt: new Date() } })).rejects.toThrow();
  });
});
