import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clock } from '../common/clock';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { OutboxDispatcher, type OutboxConsumer } from './outbox-dispatcher.service';
import { OUTBOX_CONSUMER_TIMEOUT_MS, OUTBOX_LEASE_MS, OUTBOX_SLOW_CONSUMER_PAUSE_MS } from './outbox-rules';

/**
 * The dispatcher's protection against a slow consumer (one dead mail server must not hold up every module's events),
 * with the database replaced by a stub. The database side (claiming, retry delays) is tested in test/m4-alerts.test.ts.
 */
class StepClock extends Clock {
  constructor(private ms: number) {
    super();
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

interface Row {
  id: string;
  type: string;
  version: number;
  actor: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
}
interface UpdateCall {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

const START = Date.parse('2030-01-01T10:00:00.000Z');

/** A valid auth.logout event as the database returns it right after a claim (the claim counted one try). */
function logoutRow(): Row {
  return {
    id: randomUUID(),
    type: 'auth.logout',
    version: 1,
    actor: 'ACV-0007',
    payload: { empId: 'ACV-0007', sessionId: randomUUID(), reason: 'user' },
    occurred_at: new Date(START),
    attempts: 1,
  };
}

const handlesLogout = [{ type: 'auth.logout' as const, version: 1 }];
const consumer = (name: string, handle: OutboxConsumer['handle']): OutboxConsumer => ({ name, handles: handlesLogout, handle });
/** A consumer that never answers (a mail server that drops packets). */
const hangs = () => vi.fn(() => new Promise<void>(() => undefined));

function setup(consumers: OutboxConsumer[]) {
  const clock = new StepClock(START);
  const updates: UpdateCall[] = [];
  const deliveries: Array<{ eventId: string; consumer: string }> = [];
  const batches: Row[][] = [];
  const prisma = {
    $queryRaw: vi.fn(async () => batches.shift() ?? []),
    outboxDelivery: {
      findMany: vi.fn(async ({ where }: { where: { eventId: string } }) => deliveries.filter((d) => d.eventId === where.eventId).map((d) => ({ consumer: d.consumer }))),
      createMany: vi.fn(async ({ data }: { data: Array<{ eventId: string; consumer: string }> }) => {
        deliveries.push(...data.map((d) => ({ eventId: d.eventId, consumer: d.consumer })));
        return { count: data.length };
      }),
    },
    outboxEvent: {
      updateMany: vi.fn(async (args: UpdateCall) => {
        updates.push(args);
        return { count: 1 };
      }),
    },
  };
  const dispatcher = new OutboxDispatcher(prisma as unknown as PrismaService, clock, { OUTBOX_DISPATCH_INTERVAL_MS: 0 } as Env);
  for (const c of consumers) dispatcher.register(c);
  return { dispatcher, clock, prisma, updates, deliveries, batches };
}

/** The write that settled one event (processed, retry or wait). */
const settled = (updates: UpdateCall[], row: Row) => updates.find((u) => u.where.id === row.id)?.data;

/** Runs one tick and lets the fake timers pass, so a consumer that never answers runs into its time limit. */
async function tickThroughTimeouts(dispatcher: OutboxDispatcher): Promise<number> {
  const done = dispatcher.tick();
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(OUTBOX_CONSUMER_TIMEOUT_MS);
  return done;
}

beforeAll(() => {
  Logger.overrideLogger(false); // the warnings about failing consumers are expected here
});
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OutboxDispatcher: a consumer that never answers', () => {
  it('times out after the limit, is retried later like any failure, and the other consumers and events carry on', async () => {
    const ok = vi.fn(async () => undefined);
    const hung = hangs();
    const t = setup([consumer('test.ok', ok), consumer('test.hung', hung)]);
    const [a, b] = [logoutRow(), logoutRow()];
    t.batches.push([a, b]);

    expect(await tickThroughTimeouts(t.dispatcher)).toBe(2);

    // First event: the working consumer succeeded and is recorded; the hung one failed with a time-out and is retried in 10 s.
    expect(t.deliveries).toEqual(expect.arrayContaining([{ eventId: a.id, consumer: 'test.ok' }]));
    expect(t.deliveries.some((d) => d.eventId === a.id && d.consumer === 'test.hung')).toBe(false);
    const first = settled(t.updates, a)!;
    expect(String(first.lastError)).toContain('test.hung: timed out after 20 s');
    expect(first.processedAt).toBeUndefined();
    expect(first.nextAttemptAt).toEqual(new Date(START + 10_000));
    expect(first.attempts).toBeUndefined(); // a real failed try is counted

    // Second event: the hung consumer is paused, so it is not called again; the event waits without a failed try.
    expect(hung).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(2);
    const second = settled(t.updates, b)!;
    expect(second).toMatchObject({ lockedBy: null, lockedUntil: null, attempts: { decrement: 1 } });
    expect(String(second.lastError)).toContain('test.hung');
    expect(second.nextAttemptAt).toEqual(new Date(START + OUTBOX_SLOW_CONSUMER_PAUSE_MS));
    expect(second.processedAt).toBeUndefined();
  });

  it('is tried again once the pause is over', async () => {
    const hung = hangs();
    const t = setup([consumer('test.hung', hung)]);
    t.batches.push([logoutRow()]);
    await tickThroughTimeouts(t.dispatcher);
    expect(hung).toHaveBeenCalledTimes(1);

    t.clock.advance(OUTBOX_SLOW_CONSUMER_PAUSE_MS - 1);
    t.batches.push([logoutRow()]);
    await tickThroughTimeouts(t.dispatcher);
    expect(hung).toHaveBeenCalledTimes(1); // still paused

    t.clock.advance(2);
    t.batches.push([logoutRow()]);
    await tickThroughTimeouts(t.dispatcher);
    expect(hung).toHaveBeenCalledTimes(2);
  });

  it('a consumer that fails slowly (a mail connection that gives up after 6 s) is paused too', async () => {
    const slowFail = vi.fn(() => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('connection timed out')), 6_000)));
    const t = setup([consumer('test.mail', slowFail)]);
    const [a, b] = [logoutRow(), logoutRow()];
    t.batches.push([a, b]);
    await tickThroughTimeouts(t.dispatcher);
    expect(slowFail).toHaveBeenCalledTimes(1);
    expect(String(settled(t.updates, a)!.lastError)).toContain('test.mail: connection timed out');
    expect(settled(t.updates, b)).toMatchObject({ attempts: { decrement: 1 } });
  });

  it('a consumer that fails at once is not paused: every event is tried and counts a failed try', async () => {
    const flaky = vi.fn(async () => {
      throw new Error('payroll is down');
    });
    const t = setup([consumer('test.flaky', flaky)]);
    const [a, b] = [logoutRow(), logoutRow()];
    t.batches.push([a, b]);
    await t.dispatcher.tick();
    expect(flaky).toHaveBeenCalledTimes(2);
    for (const row of [a, b]) {
      const data = settled(t.updates, row)!;
      expect(data.lastError).toBe('test.flaky: payroll is down');
      expect(data.nextAttemptAt).toEqual(new Date(START + 10_000));
      expect(data.attempts).toBeUndefined();
    }
  });

  it('a consumer that answers late after the time-out changes nothing and raises no unhandled error', async () => {
    let finishLate: () => void = () => undefined;
    const late = vi.fn(() => new Promise<void>((_, reject) => (finishLate = () => reject(new Error('too late')))));
    const t = setup([consumer('test.late', late)]);
    const a = logoutRow();
    t.batches.push([a]);
    await tickThroughTimeouts(t.dispatcher);
    const before = t.updates.length;
    finishLate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.updates.length).toBe(before);
    expect(String(settled(t.updates, a)!.lastError)).toContain('timed out');
  });

  it('events that every consumer handled are marked processed, and a consumer that succeeded is not called again', async () => {
    const ok = vi.fn(async () => undefined);
    const flaky = vi.fn(async () => {
      if (flaky.mock.calls.length === 1) throw new Error('once');
    });
    const t = setup([consumer('test.ok', ok), consumer('test.flaky', flaky)]);
    const a = logoutRow();
    t.batches.push([a]);
    await t.dispatcher.tick();
    expect(settled(t.updates, a)!.processedAt).toBeUndefined();

    t.batches.push([{ ...a, attempts: 2 }]);
    t.updates.length = 0;
    await t.dispatcher.tick();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(settled(t.updates, a)).toMatchObject({ processedAt: new Date(START), lastError: null, nextAttemptAt: null });
  });
});

describe('OutboxDispatcher: the claim on a long batch', () => {
  it('renews the lease of the events still waiting once the batch has run for a while', async () => {
    const slowOk = vi.fn(async () => {
      t.clock.advance(40_000); // this event took 40 s
    });
    const t = setup([consumer('test.slow', slowOk)]);
    const [a, b, c] = [logoutRow(), logoutRow(), logoutRow()];
    t.batches.push([a, b, c]);
    await t.dispatcher.tick();

    const renewals = t.updates.filter((u) => u.where.id && typeof u.where.id === 'object' && 'in' in (u.where.id as object) && 'lockedUntil' in u.data && Object.keys(u.data).length === 1);
    expect(renewals).toHaveLength(2); // before b (a took 40 s) and before c (b took another 40 s)
    expect((renewals[0].where.id as { in: string[] }).in).toEqual([b.id, c.id]);
    expect((renewals[1].where.id as { in: string[] }).in).toEqual([c.id]);
    expect(renewals[0].data.lockedUntil).toEqual(new Date(START + 40_000 + OUTBOX_LEASE_MS));
    expect(renewals[0].where).toMatchObject({ processedAt: null });
  });

  it('does not touch the lease while the batch is quick', async () => {
    const t = setup([consumer('test.fast', async () => undefined)]);
    t.batches.push([logoutRow(), logoutRow(), logoutRow()]);
    await t.dispatcher.tick();
    expect(t.updates.filter((u) => 'lockedUntil' in u.data && u.data.processedAt === undefined)).toHaveLength(0);
    expect(t.updates.filter((u) => u.data.processedAt)).toHaveLength(3);
  });

  it('hands the rest of the batch back untried when the server is shutting down', async () => {
    let stopping: Promise<void> | null = null;
    const first = vi.fn(async () => {
      stopping = t.dispatcher.onModuleDestroy(); // Ctrl+C while the first event is being handled
    });
    const t = setup([consumer('test.stop', first)]);
    const [a, b, c] = [logoutRow(), logoutRow(), logoutRow()];
    t.batches.push([a, b, c]);
    await t.dispatcher.tick();
    await stopping;

    expect(first).toHaveBeenCalledTimes(1); // the event in hand was finished
    expect(settled(t.updates, a)!.processedAt).toEqual(new Date(START));
    const released = t.updates.find((u) => typeof u.where.id === 'object');
    expect((released!.where.id as { in: string[] }).in).toEqual([b.id, c.id]);
    expect(released!.data).toEqual({ lockedUntil: null, lockedBy: null, attempts: { decrement: 1 } });
    expect(await t.dispatcher.tick()).toBe(0); // and nothing new is claimed
  });
});

describe('the time limit is shorter than the claim', () => {
  it('lets several consumers of one event finish inside the lease', () => {
    expect(OUTBOX_CONSUMER_TIMEOUT_MS * 4).toBeLessThan(OUTBOX_LEASE_MS);
  });
});
