import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
let HR = ''; // test-only HR officer (not in the demo seed), see helpers/people.ts
const FINANCE = 'ACV-0010';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const EXE = Buffer.from('MZ\x90\x00this is a program', 'latin1');

let t: TestApp;
let prisma: PrismaClient;
let cvId: string;

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  HR = t.fixtures.HR;
  prisma = createTestPrisma();
});
afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

const upload = (who: string, target: string, file: Buffer, name: string, type = 'cv') =>
  t.as(who).post(`/api/v1/employees/${target}/documents`).field('type', type).attach('file', file, name);
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));

describe('M3 documents in private storage', () => {
  it('lets an employee add their own CV; it is stored privately under a generated name', async () => {
    const res = await upload(DEV1, DEV1, PDF, 'My CV (final).pdf').expect(201);
    cvId = res.body.id;
    expect(res.body).toMatchObject({ kind: 'cv', fileName: 'My CV (final).pdf', mimeType: 'application/pdf', uploadedBy: DEV1 });
    const row = await prisma.employeeDocument.findUniqueOrThrow({ where: { id: cvId } });
    expect(row.storageKey).toMatch(/^employees\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\.pdf$/);
    expect(row.storageKey).not.toContain('CV');
    expect(row.sha256).toHaveLength(64);
    expect(existsSync(join(t.storageRoot, row.storageKey))).toBe(true);
  });

  it('has no public path to the files: the API never serves the storage folder or returns storage keys', async () => {
    const list = JSON.stringify((await t.as(DIRECTOR).get(`/api/v1/employees/${DEV1}/documents`).expect(200)).body);
    expect(list).not.toContain('storageKey');
    expect(list).not.toContain('employees/');
    await t.anonymous().get(`/api/v1/employees/${DEV1}/documents/${cvId}/download`).expect(401);
    await t.as(DIRECTOR).get('/employees/x/documents/y').expect(404);
    expect(JSON.stringify((await t.as(DIRECTOR).get(`/api/v1/employees/${DEV1}`).expect(200)).body)).not.toContain('storageKey');
  });

  it('shows documents to the employee, HR, Director and above only', async () => {
    for (const who of [DEV1, HR, DIRECTOR]) expect((await t.as(who).get(`/api/v1/employees/${DEV1}/documents`).expect(200)).body).toHaveLength(1);
    for (const who of [DEV2, CTO, FINANCE]) await t.as(who).get(`/api/v1/employees/${DEV1}/documents`).expect(403);
    expect((await t.as(HR).get(`/api/v1/employees/${DEV1}`).expect(200)).body.documents).toHaveLength(1);
    expect((await t.as(DEV2).get(`/api/v1/employees/${DEV1}`).expect(200)).body.documents).toBeUndefined();
  });

  it('downloads the exact file for allowed people with safe headers, and logs every download', async () => {
    const res = await t.as(HR).get(`/api/v1/employees/${DEV1}/documents/${cvId}/download`).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(await prisma.auditLog.count({ where: { action: 'employee.document.downloaded', targetId: DEV1 } })).toBe(1);
  });

  it('refuses downloads by others, and does not let a document be read through another employee (IDOR)', async () => {
    await t.as(DEV2).get(`/api/v1/employees/${DEV1}/documents/${cvId}/download`).expect(403);
    await t.as(CTO).get(`/api/v1/employees/${DEV1}/documents/${cvId}/download`).expect(403);
    // a document id used under someone else's profile is not found, even for HR
    await t.as(HR).get(`/api/v1/employees/${DEV2}/documents/${cvId}/download`).expect(404);
    // the employee cannot read someone else's profile documents with their own permission
    await t.as(DEV1).get(`/api/v1/employees/${DEV2}/documents/${cvId}/download`).expect(403);
    await t.as(HR).get(`/api/v1/employees/${DEV1}/documents/not-a-uuid/download`).expect(400);
  });

  it('accepts only PDF, PNG, JPEG and .docx judged by the real file content, not the name', async () => {
    await upload(DEV1, DEV1, EXE, 'cv.pdf').expect(400); // an executable renamed to .pdf
    await upload(DEV1, DEV1, Buffer.from('<script>alert(1)</script>'), 'page.html').expect(400);
    await upload(DEV1, DEV1, Buffer.alloc(0), 'empty.pdf').expect(400);
    await upload(DEV1, DEV1, PNG, 'cnic-front.exe', 'cnic_copy').expect(201); // a real PNG is fine whatever the name says
    const row = await prisma.employeeDocument.findFirstOrThrow({ where: { type: 'cnic_copy' } });
    expect(row.storageKey.endsWith('.png')).toBe(true);
    expect(row.mimeType).toBe('image/png');
  });

  it('limits the size and the type of document', async () => {
    await upload(DEV1, DEV1, Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]), 'huge.pdf').expect(413);
    await upload(DEV1, DEV1, PDF, 'x.pdf', 'resume').expect(400);
    await t.as(DEV1).post(`/api/v1/employees/${DEV1}/documents`).field('type', 'cv').expect(400); // no file
  });

  it('cleans up a path-like name and keeps files out of other folders', async () => {
    const res = await upload(DEV1, DEV1, PDF, '../../etc/passwd.pdf', 'certificate').expect(201);
    expect(res.body.fileName).toBe('passwd.pdf');
    const files = filesUnder(t.storageRoot);
    files.forEach((f) => expect(f.replace(/\\/g, '/')).toContain('/employees/'));
  });

  it('lets HR add a contract, but an employee cannot add their own contract', async () => {
    await upload(HR, DEV1, PDF, 'contract.pdf', 'contract').expect(201);
    await upload(DEV1, DEV1, PDF, 'contract.pdf', 'contract').expect(403);
  });

  it('refuses uploads for people who may not manage the employee', async () => {
    for (const who of [DEV2, CTO, FINANCE]) await upload(who, DEV1, PDF, 'cv.pdf').expect(403);
    await upload(HR, DIRECTOR, PDF, 'cv.pdf').expect(403); // upward
  });

  it('archives instead of deleting: the record and the file stay', async () => {
    const row = await prisma.employeeDocument.findUniqueOrThrow({ where: { id: cvId } });
    await t.as(DEV2).delete(`/api/v1/employees/${DEV1}/documents/${cvId}`).expect(403);
    await t.as(DEV1).delete(`/api/v1/employees/${DEV1}/documents/${cvId}`).expect(200);
    const after = await prisma.employeeDocument.findUniqueOrThrow({ where: { id: cvId } });
    expect(after.archivedAt).not.toBeNull();
    expect(existsSync(join(t.storageRoot, row.storageKey))).toBe(true);
    expect(readFileSync(join(t.storageRoot, row.storageKey)).equals(PDF)).toBe(true);
    await t.as(DEV1).get(`/api/v1/employees/${DEV1}/documents/${cvId}/download`).expect(404);
    expect(((await t.as(DEV1).get(`/api/v1/employees/${DEV1}/documents`).expect(200)).body as Array<{ id: string }>).some((d) => d.id === cvId)).toBe(false);
  });
});

describe('M3 profile photo', () => {
  it('lets an employee set their photo; every employee can see it (basic information)', async () => {
    await t.as(DEV1).post(`/api/v1/employees/${DEV1}/photo`).attach('file', PNG, 'me.png').expect(201);
    const res = await t.as(DEV2).get(`/api/v1/employees/${DEV1}/photo`).expect(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(((await t.as(DEV2).get('/api/v1/employees').expect(200)).body as Array<{ empId: string; hasPhoto: boolean }>).find((e) => e.empId === DEV1)!.hasPhoto).toBe(true);
    await t.anonymous().get(`/api/v1/employees/${DEV1}/photo`).expect(401);
    await t.as(DEV2).get(`/api/v1/employees/${DEV2}/photo`).expect(404); // none set
  });

  it('accepts only images, only for yourself or people below you, and replaces the old one', async () => {
    await t.as(DEV1).post(`/api/v1/employees/${DEV1}/photo`).attach('file', PDF, 'me.pdf').expect(400);
    await t.as(DEV2).post(`/api/v1/employees/${DEV1}/photo`).attach('file', PNG, 'x.png').expect(403);
    const before = (await prisma.employee.findUniqueOrThrow({ where: { empId: DEV1 } })).photoKey!;
    await t.as(HR).post(`/api/v1/employees/${DEV1}/photo`).attach('file', PNG, 'new.png').expect(201);
    const after = (await prisma.employee.findUniqueOrThrow({ where: { empId: DEV1 } })).photoKey!;
    expect(after).not.toBe(before);
    expect(existsSync(join(t.storageRoot, before))).toBe(false); // the old photo is replaced
    expect(existsSync(join(t.storageRoot, after))).toBe(true);
  });
});
