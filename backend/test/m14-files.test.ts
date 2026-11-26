import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMS_FILE_SCAN_JOB } from '../src/comms/comms-file.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { JobRunner } from '../src/jobs/job-runner.service';
import { FILE_STORAGE, type FileStorage } from '../src/storage/file-storage';
import { MALWARE_SCANNER, type MalwareScanner, type ScanResult } from '../src/storage/malware-scanner';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 14 file sharing (plan section 19): type and size limits, malware scanning (fail closed), private storage and
 * permission-checked downloads, for message files and meeting files. The scanner here is a controllable stand-in so
 * every verdict can be exercised; the real ClamAV is checked by m14-clamav.test.ts.
 */
const API = '/api/v1/comms';
const DIRECTOR = 'ACV-0003';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const DEV3 = 'ACV-0008';
const SALES1 = 'ACV-0009';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

let verdict: ScanResult = { verdict: 'clean' };
const scanned: number[] = [];
const scanner: MalwareScanner = {
  scan: async (data) => {
    scanned.push(data.length);
    return verdict;
  },
};

let t: TestApp;
let prisma: PrismaClient;
let storage: FileStorage;
const as = (empId: string) => t.as(empId);
const conv = (id: string) => `${API}/conversations/${id}`;

async function upload(who: string, path: string, data: Buffer, name: string, status = 201) {
  const res = await as(who).post(path).attach('file', data, name);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}

async function send(who: string, conversationId: string, body: string, attachmentIds: string[], status = 201) {
  const res = await as(who).post(`${conv(conversationId)}/messages`).send({ clientKey: randomUUID(), body, attachmentIds });
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}

let group = '';

beforeAll(async () => {
  t = await createTestApp({ overrides: [{ provide: MALWARE_SCANNER, useValue: scanner }] });
  await t.signInAll();
  prisma = createTestPrisma();
  storage = t.app.get(FILE_STORAGE);
  const res = await as(DEV1).post(`${API}/conversations`).send({ kind: 'group', name: 'Files group', memberEmpIds: [DEV2] });
  group = res.body.conversation.id;
});

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120_000);

describe('limits', () => {
  it('accepts PDF, PNG, JPEG and Word by their content, at most 10 MB, from members who may post', async () => {
    expect((await upload(DEV1, `${conv(group)}/files`, Buffer.from('MZ fake program'), 'tool.pdf', 400)).code).toBe('file_type_not_allowed');
    // Refused by the upload layer just above 10 MB (413), before the file reaches the service.
    expect((await upload(DEV1, `${conv(group)}/files`, Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]), 'big.pdf', 413)).message).toMatch(/too large/i);
    expect((await as(DEV1).post(`${conv(group)}/files`)).status).toBe(400);
    await upload(SALES1, `${conv(group)}/files`, PDF, 'outsider.pdf', 404);
    const ok = await upload(DEV1, `${conv(group)}/files`, PNG, 'screen.png');
    expect(ok).toMatchObject({ fileName: 'screen.png', mimeType: 'image/png', sizeBytes: PNG.length, scan: 'clean', uploaderEmpId: DEV1 });
  });
});

describe('scanning', () => {
  it('scans in memory before storing; a clean file is stored privately and can be sent and downloaded by members', async () => {
    verdict = { verdict: 'clean' };
    const before = scanned.length;
    const file = await upload(DEV1, `${conv(group)}/files`, PDF, 'plan.pdf');
    expect(scanned.length).toBe(before + 1);
    const row = await prisma.commsFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.storageKey.startsWith(`comms/conversations/${group}/`)).toBe(true);
    expect(await storage.exists(row.storageKey)).toBe(true);
    const sent = await send(DEV1, group, 'The plan is attached', [file.id]);
    expect(sent.message.attachments.map((a: { id: string }) => a.id)).toEqual([file.id]);
    const dl = await as(DEV2).get(`${API}/files/${file.id}/download`).buffer(true);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect(dl.headers['content-disposition']).toContain('attachment;');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.from(dl.body).equals(PDF)).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'comms.file.downloaded', targetId: file.id } })).toBe(1);
    const history = await as(DEV2).get(`${conv(group)}/messages`);
    expect(history.body.items.at(-1).attachments[0]).toMatchObject({ id: file.id, scan: 'clean' });
  });

  it('blocks malware for good: never stored, never downloadable, audited with the finding only', async () => {
    verdict = { verdict: 'infected', signature: 'Win.Test.EICAR_HDB-1' };
    const file = await upload(DEV1, `${conv(group)}/files`, PDF, 'invoice.pdf');
    expect(file.scan).toBe('blocked');
    const row = await prisma.commsFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.scanSignature).toBe('Win.Test.EICAR_HDB-1');
    expect(await storage.exists(row.storageKey)).toBe(false);
    expect((await as(DEV1).get(`${API}/files/${file.id}/download`)).status).toBe(410);
    expect((await as(DEV1).post(`${conv(group)}/messages`).send({ clientKey: randomUUID(), body: 'try', attachmentIds: [file.id] })).body.code).toBe('invalid_attachments');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'comms.file.blocked', targetId: file.id } });
    expect(audit.details).toEqual({ signature: 'Win.Test.EICAR_HDB-1' });
  });

  it('fails closed when the scanner is down: the file waits unopenable, and a job checks it again until it answers', async () => {
    verdict = { verdict: 'unavailable', reason: 'ECONNREFUSED' };
    const file = await upload(DEV1, `${conv(group)}/files`, PDF, 'later.pdf');
    expect(file.scan).toBe('scanning');
    const sent = await send(DEV1, group, 'Waiting for its check', [file.id]);
    expect(sent.message.attachments[0].scan).toBe('scanning');
    expect((await as(DEV2).get(`${API}/files/${file.id}/download`)).body.code).toBe('file_scanning');
    const job = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: `${COMMS_FILE_SCAN_JOB}:${file.id}` } });
    expect(job.status).toBe('pending');

    // Still down when the job runs: it fails and will try again; the file stays closed.
    t.clock.advance(61_000);
    await t.app.get(JobRunner).tick();
    expect((await prisma.commsFile.findUniqueOrThrow({ where: { id: file.id } })).scanStatus).toBe('scanning');
    expect((await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: `${COMMS_FILE_SCAN_JOB}:${file.id}` } })).status).toBe('pending');

    // The scanner is back: the next run clears it, and members can open it; the message shows it live.
    verdict = { verdict: 'clean' };
    t.clock.advance(61_000);
    await t.app.get(JobRunner).tick();
    expect((await prisma.commsFile.findUniqueOrThrow({ where: { id: file.id } })).scanStatus).toBe('clean');
    expect((await as(DEV2).get(`${API}/files/${file.id}/download`)).status).toBe(200);
    expect(await prisma.outboxEvent.count({ where: { type: 'comms.message.changed', payload: { path: ['change'], equals: 'file_scanned' } } })).toBeGreaterThanOrEqual(1);
  });
});

describe('who may attach and download', () => {
  it('attaches only my own unsent files of this conversation, once', async () => {
    verdict = { verdict: 'clean' };
    const mine = await upload(DEV1, `${conv(group)}/files`, PDF, 'mine.pdf');
    expect((await as(DEV2).post(`${conv(group)}/messages`).send({ clientKey: randomUUID(), body: 'not mine', attachmentIds: [mine.id] })).body.code).toBe('invalid_attachments');
    const other = (await as(DEV1).post(`${API}/conversations`).send({ kind: 'dm', empId: DEV3 })).body.conversation.id;
    expect((await as(DEV1).post(`${conv(other)}/messages`).send({ clientKey: randomUUID(), body: 'wrong place', attachmentIds: [mine.id] })).body.code).toBe('invalid_attachments');
    await send(DEV1, group, 'first time', [mine.id]);
    expect((await as(DEV1).post(`${conv(group)}/messages`).send({ clientKey: randomUUID(), body: 'second time', attachmentIds: [mine.id] })).body.code).toBe('invalid_attachments');
    // An unsent file is its uploader's only.
    const pending = await upload(DEV1, `${conv(group)}/files`, PDF, 'draft.pdf');
    expect((await as(DEV2).get(`${API}/files/${pending.id}`)).status).toBe(404);
    expect((await as(DEV1).get(`${API}/files/${pending.id}`)).status).toBe(200);
  });

  it('refuses outsiders, people whose history starts after the message, and files of a deleted message', async () => {
    verdict = { verdict: 'clean' };
    t.clock.advance(61_000); // a fresh minute for the sending limit
    const file = await upload(DEV1, `${conv(group)}/files`, PDF, 'early.pdf');
    const sent = await send(DEV1, group, 'Before Ali joined', [file.id]);
    for (const who of [SALES1, DIRECTOR]) expect((await as(who).get(`${API}/files/${file.id}/download`)).status).toBe(404);
    expect((await as(DEV1).post(`${conv(group)}/members`).send({ empIds: [DEV3] })).status).toBe(200);
    expect((await as(DEV3).get(`${API}/files/${file.id}/download`)).status).toBe(404); // sent before he joined
    expect((await as(DEV2).get(`${API}/files/${file.id}/download`)).status).toBe(200);
    expect((await as(DEV1).delete(`${API}/messages/${sent.message.id}`)).status).toBe(200);
    expect((await as(DEV2).get(`${API}/files/${file.id}/download`)).status).toBe(404);
    expect((await as(DEV2).get(`${conv(group)}/messages`)).body.items.find((m: { id: string }) => m.id === sent.message.id).attachments).toEqual([]);
  });

  it('refuses uploads to an archived conversation', async () => {
    const g = (await as(DEV1).post(`${API}/conversations`).send({ kind: 'group', name: 'Archive me', memberEmpIds: [DEV2] })).body.conversation.id;
    expect((await as(DEV1).post(`${conv(g)}/archive`).send({ reason: 'Done with this group' })).status).toBe(200);
    expect((await upload(DEV1, `${conv(g)}/files`, PDF, 'late.pdf', 409)).code).toBe('conversation_archived');
  });
});

describe('meeting files', () => {
  it('are added by the organizer only and opened by the people invited, nobody else', async () => {
    verdict = { verdict: 'clean' };
    const meeting = (
      await as(DEV1).post(`${API}/meetings`).send({ title: 'File review', startsAt: new Date(t.clock.now().getTime() + 86_400_000).toISOString(), durationMin: 30, location: 'Video call', participantEmpIds: [DEV2] })
    ).body;
    expect((await upload(DEV2, `${API}/meetings/${meeting.id}/files`, PDF, 'invitee.pdf', 403)).code).toBe('organizer_only');
    await upload(SALES1, `${API}/meetings/${meeting.id}/files`, PDF, 'outsider.pdf', 404);
    const file = await upload(DEV1, `${API}/meetings/${meeting.id}/files`, PDF, 'slides.pdf');
    expect((await as(DEV2).get(`${API}/meetings/${meeting.id}`)).body.attachments.map((a: { id: string }) => a.id)).toEqual([file.id]);
    expect((await as(DEV2).get(`${API}/files/${file.id}/download`)).status).toBe(200);
    expect((await as(SALES1).get(`${API}/files/${file.id}/download`)).status).toBe(404);
    expect((await as(DIRECTOR).get(`${API}/files/${file.id}`)).status).toBe(404);
  });
});

describe('database rules', () => {
  it('never deletes a file record, never changes what was uploaded or a finished scan', async () => {
    const f = await prisma.commsFile.findFirstOrThrow({ where: { scanStatus: 'clean' } });
    await expect(prisma.commsFile.delete({ where: { id: f.id } })).rejects.toThrow(/attachment_rule/);
    await expect(prisma.commsFile.update({ where: { id: f.id }, data: { fileName: 'renamed.pdf' } })).rejects.toThrow(/attachment_rule/);
    await expect(prisma.commsFile.update({ where: { id: f.id }, data: { scanStatus: 'scanning', scannedAt: null } })).rejects.toThrow(/attachment_rule/);
  });
});
