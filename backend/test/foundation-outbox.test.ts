import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OutboxEvent } from '@aceva/contracts';
import type { PrismaClient } from '../src/generated/prisma/client';
import { MAX_CONSUMER_ATTEMPTS, OutboxConsumerRunner } from '../src/events/outbox-consumer-runner.service';
import { OutboxService } from '../src/events/outbox.service';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Cycle 3 foundation: several readers per outbox event, each exactly once. Test readers record what they handled as
 * audit rows written in the handler's own transaction, so a rolled-back attempt leaves nothing behind.
 */
let t: TestApp;
let prisma: PrismaClient;
let runner: OutboxConsumerRunner;
let outbox: OutboxService;

const suffix = randomUUID().slice(0, 8);
const name = (n: string) => `test_${n}_${suffix}`;

/** A reader of payslip.issued that writes one audit row per handled event (inside the claim transaction). */
function auditingReader(reader: string, opts: { fail?: () => boolean } = {}) {
  runner.register({
    name: reader,
    types: ['payslip.issued'],
    handle: async (event: OutboxEvent, tx) => {
      await tx.auditLog.create({ data: { action: `test.consumer.${reader}`, targetType: 'outbox_event', targetId: event.id, outcome: 'success' } });
      if (opts.fail?.()) throw new Error('Handler failed on purpose');
    },
  });
}
const handled = (reader: string, eventId?: string) => prisma.auditLog.count({ where: { action: `test.consumer.${reader}`, ...(eventId ? { targetId: eventId } : {}) } });
const consumption = (reader: string, eventId: string) => prisma.outboxConsumption.findUnique({ where: { consumer_eventId: { consumer: reader, eventId } } });

async function emitPayslip(month: string): Promise<string> {
  await outbox.emit({ type: 'payslip.issued', actor: 'system', payload: { empId: 'ACV-0006', month } });
  const row = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'payslip.issued', payload: { path: ['month'], equals: month } }, orderBy: { createdAt: 'desc' } });
  return row.id;
}

beforeAll(async () => {
  t = await createTestApp();
  prisma = createTestPrisma();
  runner = t.app.get(OutboxConsumerRunner);
  outbox = t.app.get(OutboxService);
}, 120000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('Cycle 3 foundation: outbox readers', () => {
  it('two readers each handle the same event exactly once; running them again changes nothing', async () => {
    const [a, b] = [name('a'), name('b')];
    auditingReader(a);
    auditingReader(b);
    await runner.drain(a); // registers both readers' starting point before the event is written
    await runner.drain(b);
    const id = await emitPayslip('2030-01');

    expect((await runner.drain(a))[a]).toMatchObject({ done: 1 });
    expect((await runner.drain(b))[b]).toMatchObject({ done: 1 });
    await runner.drain(a);
    await runner.drain(b);
    await runner.drain();
    expect(await handled(a, id)).toBe(1);
    expect(await handled(b, id)).toBe(1);
    expect(await consumption(a, id)).toMatchObject({ status: 'done', attempts: 1 });
    // the column of the reader that predates Cycle 3 (final settlements) is left alone
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id } })).processedAt).toBeNull();
  });

  it('two runs racing for the same event: it is handled once', async () => {
    const c = name('c');
    auditingReader(c);
    await runner.drain(c);
    const id = await emitPayslip('2030-02');
    const results = await Promise.all([runner.drain(c), runner.drain(c), runner.drain(c)]);
    expect(results.reduce((s, r) => s + r[c].done, 0)).toBe(1);
    expect(await handled(c, id)).toBe(1);
  });

  it('a failing handler is rolled back and tried again later, with a growing delay, until it succeeds', async () => {
    const d = name('d');
    let failing = true;
    auditingReader(d, { fail: () => failing });
    await runner.drain(d);
    const id = await emitPayslip('2030-03');

    expect((await runner.drain(d))[d]).toMatchObject({ failed: 1, done: 0 });
    expect(await consumption(d, id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await handled(d, id)).toBe(0); // the attempt's writes were rolled back
    expect((await consumption(d, id))?.lastError).toMatch(/Handler failed on purpose/);

    expect((await runner.drain(d))[d]).toMatchObject({ failed: 0, done: 0 }); // not before its retry time
    t.clock.advance(31_000);
    expect((await runner.drain(d))[d]).toMatchObject({ failed: 1 });
    expect(await consumption(d, id)).toMatchObject({ status: 'failed', attempts: 2 });

    failing = false;
    t.clock.advance(2 * 60_000 + 1_000);
    expect((await runner.drain(d))[d]).toMatchObject({ done: 1 });
    expect(await consumption(d, id)).toMatchObject({ status: 'done', attempts: 3, lastError: null });
    expect(await handled(d, id)).toBe(1);
  });

  it(`gives up after ${MAX_CONSUMER_ATTEMPTS} attempts; the event stays recorded as dead and is not tried again`, async () => {
    const e = name('e');
    auditingReader(e, { fail: () => true });
    await runner.drain(e);
    const id = await emitPayslip('2030-04');
    for (let i = 0; i < MAX_CONSUMER_ATTEMPTS; i++) {
      await runner.drain(e);
      t.clock.advance(2 * 3600_000);
    }
    expect(await consumption(e, id)).toMatchObject({ status: 'dead', attempts: MAX_CONSUMER_ATTEMPTS, nextAttemptAt: null });
    expect((await runner.drain(e))[e]).toMatchObject({ done: 0, failed: 0 });
    expect(await handled(e, id)).toBe(0);
  });

  it('a new reader does not replay events written before it was registered', async () => {
    const old = await emitPayslip('2030-05');
    const f = name('f');
    auditingReader(f);
    expect((await runner.drain(f))[f]).toMatchObject({ done: 0 });
    expect(await consumption(f, old)).toBeNull();
    const fresh = await emitPayslip('2030-06');
    expect((await runner.drain(f))[f]).toMatchObject({ done: 1 });
    expect(await handled(f, fresh)).toBe(1);
  });

  it('an event that does not match its contract is skipped (recorded, never handled)', async () => {
    const g = name('g');
    auditingReader(g);
    await runner.drain(g);
    const bad = await prisma.outboxEvent.create({ data: { type: 'payslip.issued', version: 1, actor: 'system', payload: { empId: 'not-an-emp-id', month: '2030-07' } } });
    expect((await runner.drain(g))[g]).toMatchObject({ skipped: 1, done: 0 });
    expect(await consumption(g, bad.id)).toMatchObject({ status: 'skipped' });
    expect(await handled(g, bad.id)).toBe(0);
    expect((await runner.drain(g))[g]).toMatchObject({ skipped: 0 });
  });

  it('a reader name is registered only once', () => {
    expect(() => auditingReader(name('a'))).toThrow(/registered twice/);
  });
});
