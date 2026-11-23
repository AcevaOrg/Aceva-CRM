import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { ClamdScanner } from '../src/storage/malware-scanner';
import { FILE_STORAGE, type FileStorage } from '../src/storage/file-storage';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 14 file scanning against the REAL ClamAV daemon (clamd on CLAMD_HOST:CLAMD_PORT, 127.0.0.1:3310 by default;
 * see docs/SETUP.md). Like PostgreSQL and Redis, clamd must be running for this file. It uses the EICAR test file, the
 * industry-standard harmless sample every antivirus reports as malware. The string is put together at run time so this
 * source file itself never contains it (a desktop antivirus would otherwise quarantine the test).
 */
const API = '/api/v1/comms';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';

const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!$H+H*'].join('');
if (EICAR.length !== 68) throw new Error('The EICAR test sample is 68 characters'); // guards against a lost escape
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

/**
 * A minimal Word-like .docx (a zip whose entry lives under word/), stored without compression, carrying `content`.
 * The app accepts it as a .docx by its first bytes; ClamAV opens the zip and checks the entry inside.
 */
function docxCarrying(content: Buffer): Buffer {
  const name = Buffer.from('word/document.xml');
  const crc = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const localPart = Buffer.concat([local, name, content]);
  const centralPart = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

let t: TestApp;
let prisma: PrismaClient;
let group = '';

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  group = (await t.as(DEV1).post(`${API}/conversations`).send({ kind: 'group', name: 'ClamAV check', memberEmpIds: [DEV2] })).body.conversation.id;
});

afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120_000);

describe('the real ClamAV daemon', () => {
  it('answers: a clean file is clean, the EICAR sample is malware', async () => {
    const scanner = new ClamdScanner(process.env.CLAMD_HOST ?? '127.0.0.1', Number(process.env.CLAMD_PORT ?? 3310), 60_000);
    expect(await scanner.scan(PDF)).toEqual({ verdict: 'clean' });
    const found = await scanner.scan(Buffer.from(EICAR, 'latin1'));
    expect(found.verdict).toBe('infected');
    expect(found.verdict === 'infected' && found.signature).toMatch(/eicar/i);
  });

  it('through the app: a Word file carrying the EICAR sample is blocked and never stored; a clean file is shared and opened', async () => {
    const infected = docxCarrying(Buffer.from(EICAR, 'latin1'));
    // The same container with harmless content is clean (so the block below is about the content, not the container).
    const scanner = new ClamdScanner(process.env.CLAMD_HOST ?? '127.0.0.1', Number(process.env.CLAMD_PORT ?? 3310), 60_000);
    expect(await scanner.scan(docxCarrying(Buffer.from('<w:document/>')))).toEqual({ verdict: 'clean' });
    const bad = await t.as(DEV1).post(`${API}/conversations/${group}/files`).attach('file', infected, 'invoice.docx');
    expect(bad.status, JSON.stringify(bad.body)).toBe(201);
    expect(bad.body.scan).toBe('blocked');
    const row = await prisma.commsFile.findUniqueOrThrow({ where: { id: bad.body.id } });
    expect(row.scanSignature).toMatch(/eicar/i);
    expect(await t.app.get<FileStorage>(FILE_STORAGE).exists(row.storageKey)).toBe(false);
    expect((await t.as(DEV1).get(`${API}/files/${bad.body.id}/download`)).status).toBe(410);

    const good = await t.as(DEV1).post(`${API}/conversations/${group}/files`).attach('file', PDF, 'plan.pdf');
    expect(good.body.scan).toBe('clean');
    const sent = await t.as(DEV1).post(`${API}/conversations/${group}/messages`).send({ clientKey: randomUUID(), body: 'Plan attached', attachmentIds: [good.body.id] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const dl = await t.as(DEV2).get(`${API}/files/${good.body.id}/download`).buffer(true);
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body).equals(PDF)).toBe(true);
  });
});
