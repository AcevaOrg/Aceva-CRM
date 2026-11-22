import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Clock } from '../common/clock';
import type { Env } from '../config/env';
import { OutboxDispatcher, type OutboxConsumer } from '../events/outbox-dispatcher.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ActivityConsumers } from './activity-consumers.service';

/**
 * The alert mail goes through the outbox dispatcher (docs/SETUP.md: "If Mailpit is not running ... the email is
 * retried"). Here the real consumer registration meets the real dispatcher with a stub database: when the mailer fails,
 * the alert itself stays (it is written by another consumer), and the mail is retried later.
 */
const START = Date.parse('2030-01-01T10:00:00.000Z');

class StepClock extends Clock {
  now(): Date {
    return new Date(START);
  }
}

function build(mail: () => Promise<number>) {
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    $queryRaw: vi.fn(async () => rows.splice(0)),
    outboxDelivery: { findMany: vi.fn(async () => []), createMany: vi.fn(async () => ({ count: 1 })) },
    outboxEvent: {
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: 1 };
      }),
    },
  };
  const dispatcher = new OutboxDispatcher(prisma as unknown as PrismaService, new StepClock(), { OUTBOX_DISPATCH_INTERVAL_MS: 0 } as Env);
  const alerts = { mail: vi.fn(mail), evaluate: vi.fn(async () => undefined) };
  const consumers = new ActivityConsumers(dispatcher, {} as never, {} as never, alerts as never, {} as never);
  consumers.onModuleInit();
  return { dispatcher, alerts, updates, rows };
}

const alertRow = (alertId: string) => ({
  id: randomUUID(),
  type: 'activity.alert.raised',
  version: 1,
  actor: 'ACV-0007',
  payload: { alertId, kind: 'large_export', severity: 'medium', empId: 'ACV-0007' },
  occurred_at: new Date(START),
  attempts: 1,
});

beforeAll(() => {
  Logger.overrideLogger(false);
});

describe('Module 4 outbox consumers', () => {
  it('registers the three consumers for the events they handle', () => {
    const registered: OutboxConsumer[] = [];
    new ActivityConsumers({ register: (c: OutboxConsumer) => registered.push(c) } as never, {} as never, {} as never, {} as never, {} as never).onModuleInit();
    expect(registered.map((c) => [c.name, c.handles.map((h) => h.type)])).toEqual([
      ['activity.auth', ['auth.login', 'auth.login_failed', 'auth.logout', 'auth.security']],
      ['activity.alert-rules', ['activity.flagged']],
      ['activity.alert-mail', ['activity.alert.raised']],
    ]);
  });

  it('mails an alert once the mailer works', async () => {
    const alertId = randomUUID();
    const t = build(async () => 2);
    t.rows.push(alertRow(alertId));
    expect(await t.dispatcher.tick()).toBe(1);
    expect(t.alerts.mail).toHaveBeenCalledWith(alertId);
    expect(t.updates[0].data).toMatchObject({ processedAt: new Date(START), lastError: null });
  });

  it('when the mail server is down the event is kept and retried in 10 seconds, and nothing else is affected', async () => {
    const t = build(async () => {
      throw new Error('Mail server unreachable');
    });
    const row = alertRow(randomUUID());
    t.rows.push(row);
    expect(await t.dispatcher.tick()).toBe(1);
    expect(t.updates).toHaveLength(1);
    expect(t.updates[0].where).toMatchObject({ id: row.id });
    expect(t.updates[0].data).toMatchObject({ lastError: 'activity.alert-mail: Mail server unreachable', nextAttemptAt: new Date(START + 10_000) });
    expect(t.updates[0].data.processedAt).toBeUndefined(); // not processed: the next try will mail it
  });
});
