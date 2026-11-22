import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clock } from '../common/clock';
import { ActionRecorderInterceptor, readsOut } from './action-recorder.interceptor';
import { ACTIVITY_FLUSH_MS, ActivityRecorder, type ActivityRecord } from './activity-recorder.service';

/**
 * The rule that a failed activity write never breaks or slows a request (plan section 8: events are saved in the
 * background), and what the recorder does when the database fails: keep the records and their order while the database
 * is away, write the good ones around a refused one, drop a refused one after 3 tries. The database is a stub that can
 * be switched off, made to refuse chosen records or made to never answer.
 */
type Row = Record<string, unknown>;

function fakeDatabase() {
  const state = { reachable: true, hang: false, refuseBeats: false, refuse: new Set<string>(), queryFailsAfter: Infinity, queries: 0 };
  /** What is committed. A transaction that fails commits nothing. */
  const committed = { events: [] as Row[], beats: [] as Row[], flagged: [] as Row[] };
  const prisma = {
    session: { findMany: async () => [] },
    $queryRaw: async () => {
      state.queries++;
      if (!state.reachable || state.queries > state.queryFailsAfter) throw new Error('connection refused');
      return [1];
    },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      if (state.hang) return new Promise<T>(() => undefined);
      if (!state.reachable) throw new Error('connection refused');
      const staged = { events: [] as Row[], beats: [] as Row[], flagged: [] as Row[] };
      const tx = {
        staged,
        activityEvent: {
          createManyAndReturn: async ({ data }: { data: Row[] }) => {
            const refused = data.find((d) => state.refuse.has(String(d.description)));
            if (refused) throw new Error(`refused: ${String(refused.description)}`);
            staged.events.push(...data);
            return data.map((d) => ({ id: d.id }));
          },
        },
        activityHeartbeat: {
          createMany: async ({ data }: { data: Row[] }) => {
            if (state.refuseBeats) throw new Error('heartbeat refused');
            staged.beats.push(...data);
            return { count: data.length };
          },
        },
      };
      const result = await work(tx);
      committed.events.push(...staged.events);
      committed.beats.push(...staged.beats);
      committed.flagged.push(...staged.flagged);
      return result;
    },
  };
  const outbox = { emit: async (event: Row, tx: { staged: { flagged: Row[] } }) => void tx.staged.flagged.push(event) };
  const cities = { cityFor: () => null };
  const recorder = new ActivityRecorder(prisma as never, outbox as never, cities as never);
  return { recorder, state, committed };
}

const record = (description: string, extra: Partial<ActivityRecord> = {}): ActivityRecord => ({
  employeeId: 'emp-1',
  empId: 'ACV-0007',
  occurredAt: new Date('2030-01-01T10:00:00.000Z'),
  action: 'edit',
  module: 'People',
  description,
  device: null,
  city: null,
  ...extra,
});
const beat = (minute: number) => ({ sessionId: 's1', employeeId: 'emp-1', at: new Date(Date.UTC(2030, 0, 1, 10, minute)), active: true });
const descriptions = (rows: Row[]) => rows.map((r) => r.description);

/** Keeps the expected warnings and errors out of the test output, and lets a test check them. */
const muteLogger = () => ({
  error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
});
let logged: ReturnType<typeof muteLogger>;
beforeEach(() => {
  logged = muteLogger();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ActivityRecorder: the request never waits for the database', () => {
  it('record() and heartbeat() only fill the buffer, even when the database never answers', async () => {
    const { recorder, state } = fakeDatabase();
    state.hang = true;
    recorder.record(record('one'));
    recorder.record(record('two'));
    recorder.heartbeat(beat(1));
    expect(recorder.pending()).toBe(3);
    // a flush that is stuck on the database does not stop later records from being accepted
    void recorder.flush();
    await Promise.resolve();
    recorder.record(record('three'));
    expect(recorder.pending()).toBe(1);
  });

  it('a bad source name is refused at once (a programming mistake, not a database problem)', () => {
    const { recorder } = fakeDatabase();
    expect(() => recorder.record(record('x', { source: 'Apollo!' }))).toThrow(/lower-case/);
    expect(recorder.pending()).toBe(0);
  });
});

describe('ActivityRecorder: writing', () => {
  it('writes the buffer in order, in one transaction, with the alert event of a flagged record', async () => {
    const { recorder, committed } = fakeDatabase();
    recorder.record(record('first'));
    recorder.record(record('blocked finance screen', { action: 'blocked', financeLinked: true, module: 'Ledger' }));
    recorder.record(record('second'));
    recorder.heartbeat(beat(1));
    expect(await recorder.flush()).toBe(4);
    expect(recorder.pending()).toBe(0);
    expect(descriptions(committed.events)).toEqual(['first', 'blocked finance screen', 'second']);
    expect(committed.beats).toHaveLength(1);
    expect(committed.flagged).toHaveLength(1);
    expect(committed.flagged[0]).toMatchObject({ type: 'activity.flagged', payload: { kind: 'finance_blocked', empId: 'ACV-0007', module: 'Ledger' } });
  });

  it('looking at your own pay details is not flagged for the salary alert, someone else\'s is', async () => {
    const { recorder, committed } = fakeDatabase();
    const view = (description: string, target: string) => record(description, { action: 'sensitive_view', target, details: { category: 'salary' } });
    recorder.record(view('own salary', 'ACV-0007'));
    recorder.record(view('someone else', 'ACV-0011'));
    await recorder.flush();
    expect(committed.flagged).toHaveLength(1);
    expect(committed.flagged[0]).toMatchObject({ payload: { kind: 'salary_view' } });
  });

  it('writes nothing, and flags nothing, from a transaction that failed', async () => {
    const { recorder, state, committed } = fakeDatabase();
    state.refuse.add('bad');
    recorder.record(record('blocked', { action: 'blocked', financeLinked: true }));
    recorder.record(record('bad'));
    await recorder.flush(); // the batch fails as a whole, then the records are written one by one
    expect(descriptions(committed.events)).toEqual(['blocked']);
    expect(committed.flagged).toHaveLength(1); // the flagged record's event was written once, with its record
  });
});

describe('ActivityRecorder: the database is unreachable', () => {
  it('keeps every record and heartbeat, in order, however often it fails, and writes them when the database is back', async () => {
    const { recorder, state, committed } = fakeDatabase();
    state.reachable = false;
    recorder.record(record('e1'));
    recorder.record(record('e2'));
    recorder.heartbeat(beat(1));
    for (let i = 0; i < 5; i++) {
      expect(await recorder.flush()).toBe(0);
      recorder.record(record(`later ${i}`)); // requests keep coming meanwhile
    }
    expect(recorder.pending()).toBe(2 + 1 + 5); // nothing dropped, not even after more than 3 failed flushes
    expect(logged.warn).toHaveBeenCalled();
    expect(logged.error).not.toHaveBeenCalled();

    state.reachable = true;
    expect(await recorder.flush()).toBe(8);
    expect(descriptions(committed.events)).toEqual(['e1', 'e2', 'later 0', 'later 1', 'later 2', 'later 3', 'later 4']);
    expect(recorder.pending()).toBe(0);
  });

  it('a flush that fails never throws into the timer or the caller of record()', async () => {
    const { recorder, state } = fakeDatabase();
    state.reachable = false;
    recorder.record(record('e1'));
    await expect(recorder.flush()).resolves.toBe(0);
  });
});

describe('ActivityRecorder: one record the database refuses', () => {
  it('writes the good ones around it, retries it, and drops it after 3 tries', async () => {
    const { recorder, state, committed } = fakeDatabase();
    state.refuse.add('bad');
    recorder.record(record('good 1'));
    recorder.record(record('bad'));
    recorder.record(record('good 2'));
    recorder.heartbeat(beat(1));

    expect(await recorder.flush()).toBe(3); // good 1, good 2 and the heartbeat
    expect(descriptions(committed.events)).toEqual(['good 1', 'good 2']);
    expect(committed.beats).toHaveLength(1);
    expect(recorder.pending()).toBe(1); // 'bad' waits for the next try (1st refusal)

    recorder.record(record('good 3'));
    expect(await recorder.flush()).toBe(1);
    expect(descriptions(committed.events)).toEqual(['good 1', 'good 2', 'good 3']);
    expect(recorder.pending()).toBe(1); // 2nd refusal
    expect(logged.error).not.toHaveBeenCalled();

    expect(await recorder.flush()).toBe(0); // 3rd refusal: dropped, with an error in the log
    expect(recorder.pending()).toBe(0);
    expect(logged.error).toHaveBeenCalledTimes(1);
    expect(String(logged.error.mock.calls[0][0])).toMatch(/refused 3 times/);
    expect(descriptions(committed.events)).toEqual(['good 1', 'good 2', 'good 3']);
  });

  it('a refused heartbeat is retried and dropped the same way, without holding back the records', async () => {
    const { recorder, state, committed } = fakeDatabase();
    state.refuseBeats = true;
    recorder.record(record('fine'));
    recorder.heartbeat(beat(1));
    await recorder.flush();
    expect(descriptions(committed.events)).toEqual(['fine']);
    expect(recorder.pending()).toBe(1);
    await recorder.flush();
    await recorder.flush();
    expect(recorder.pending()).toBe(0);
    expect(committed.beats).toHaveLength(0);
    expect(logged.error).toHaveBeenCalledTimes(1);
  });

  it('records that fail again go back in their original order (not reversed)', async () => {
    const { recorder, state, committed } = fakeDatabase();
    state.refuse.add('bad 1').add('bad 2').add('bad 3');
    for (const d of ['bad 1', 'good', 'bad 2', 'bad 3']) recorder.record(record(d));
    await recorder.flush();
    expect(descriptions(committed.events)).toEqual(['good']);
    expect(recorder.pending()).toBe(3);
    state.refuse.clear();
    await recorder.flush();
    expect(descriptions(committed.events)).toEqual(['good', 'bad 1', 'bad 2', 'bad 3']);
  });

  it('when the database goes away while the records are written one by one, the rest is kept and nobody is blamed', async () => {
    const { recorder, state, committed } = fakeDatabase();
    state.refuse.add('bad');
    recorder.record(record('good 1'));
    recorder.record(record('bad'));
    recorder.record(record('good 2'));
    // 1st check (after the batch failed): reachable. 2nd check (after 'bad' failed): the database is gone.
    state.queryFailsAfter = 1;
    expect(await recorder.flush()).toBe(1);
    expect(descriptions(committed.events)).toEqual(['good 1']);
    expect(recorder.pending()).toBe(2);

    // Back again: 'bad' is refused for real now. It was not charged for the outage, so it takes 3 more tries to drop it.
    state.queryFailsAfter = Infinity;
    await recorder.flush(); // writes good 2, 'bad' 1st refusal
    expect(descriptions(committed.events)).toEqual(['good 1', 'good 2']);
    await recorder.flush(); // 2nd refusal
    expect(recorder.pending()).toBe(1);
    await recorder.flush(); // 3rd refusal: dropped
    expect(recorder.pending()).toBe(0);
    expect(logged.error).toHaveBeenCalledTimes(1);
  });
});

describe('ActivityRecorder: starting and stopping', () => {
  it('writes the buffer every second', async () => {
    vi.useFakeTimers();
    const { recorder, committed } = fakeDatabase();
    recorder.onModuleInit();
    recorder.record(record('e1'));
    await vi.advanceTimersByTimeAsync(ACTIVITY_FLUSH_MS);
    expect(descriptions(committed.events)).toEqual(['e1']);
    await recorder.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a normal shutdown writes what is still in the buffer first, and survives a database that is gone', async () => {
    const { recorder, state, committed } = fakeDatabase();
    recorder.record(record('last words'));
    recorder.heartbeat(beat(1));
    await recorder.onModuleDestroy();
    expect(descriptions(committed.events)).toEqual(['last words']);
    expect(committed.beats).toHaveLength(1);

    state.reachable = false;
    recorder.record(record('lost'));
    await expect(recorder.onModuleDestroy()).resolves.toBeUndefined(); // never throws, so the shutdown carries on
  });

  it('the server asks Nest to run that shutdown code (enableShutdownHooks in main.ts, before it listens)', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
    expect(main).toContain('app.enableShutdownHooks()');
    expect(main.indexOf('app.enableShutdownHooks()')).toBeLessThan(main.indexOf('app.listen('));
  });
});

// ---------------------------------------------------------------------------------------------------------- the interceptor

class FixedClock extends Clock {
  now(): Date {
    return new Date('2030-01-01T10:00:00.000Z');
  }
}

class Controller {
  handler(): void {
    return undefined;
  }
}

function httpContext(request: object): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => Controller.prototype.handler,
    getClass: () => Controller,
  } as unknown as ExecutionContext;
}

const requestOf = (method: string, route: string, params: Record<string, string> = {}, over: Record<string, unknown> = {}) => ({
  method,
  route: { path: route },
  params,
  actor: { id: 'emp-1', empId: 'ACV-0003' },
  sessionId: randomUUID(),
  ip: '192.0.2.10',
  requestId: randomUUID(),
  ...over,
});

const run = (interceptor: ActionRecorderInterceptor, request: object, handler = () => of({ ok: true })) =>
  firstValueFrom(interceptor.intercept(httpContext(request), { handle: handler }));

describe('ActionRecorderInterceptor: a failed activity record never breaks or slows the request', () => {
  it('answers normally even when the recorder throws', async () => {
    const recorder = { record: vi.fn(() => { throw new Error('buffer exploded'); }) };
    const interceptor = new ActionRecorderInterceptor(new Reflector(), recorder as never, new FixedClock());
    await expect(run(interceptor, requestOf('PATCH', '/api/v1/org/departments/:code', { code: 'dep-hr' }))).resolves.toEqual({ ok: true });
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(String(logged.error.mock.calls[0][0])).toContain('Could not record PATCH /api/v1/org/departments/:code');
  });

  it('does not wait for the database: the answer is back while every write is stuck', async () => {
    const { recorder, state } = fakeDatabase();
    state.hang = true;
    const interceptor = new ActionRecorderInterceptor(new Reflector(), recorder, new FixedClock());
    const change = () => run(interceptor, requestOf('PATCH', '/api/v1/org/departments/:code', { code: 'dep-hr' }));
    await expect(change()).resolves.toEqual({ ok: true });
    expect(recorder.pending()).toBe(1);

    void recorder.flush(); // this write never ends
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorder.pending()).toBe(0); // the record is with the stuck write now
    await expect(change()).resolves.toEqual({ ok: true }); // and requests are still answered at once
    expect(recorder.pending()).toBe(1);
  });

  it('records a change only after it succeeded: a failing handler records nothing', async () => {
    const { recorder } = fakeDatabase();
    const interceptor = new ActionRecorderInterceptor(new Reflector(), recorder, new FixedClock());
    await expect(run(interceptor, requestOf('POST', '/api/v1/tasks'), () => throwError(() => new Error('validation failed')))).rejects.toThrow('validation failed');
    expect(recorder.pending()).toBe(0);
  });
});

describe('ActionRecorderInterceptor: GETs that hand data out', () => {
  it('readsOut: only a GET ending in /download, /export or /print', () => {
    expect(readsOut('GET', '/api/v1/employees/:empId/documents/:documentId/download')).toBe(true);
    expect(readsOut('get', '/api/v1/finance/statements/export')).toBe(true);
    expect(readsOut('GET', '/api/v1/payroll/payslips/:id/print')).toBe(true);
    expect(readsOut('POST', '/api/v1/finance/statements/export')).toBe(false);
    expect(readsOut('GET', '/api/v1/employees/:empId')).toBe(false);
    expect(readsOut('GET', '/api/v1/downloads')).toBe(false);
  });

  it('a document download, an export and a print are recorded as such; a plain read is not', async () => {
    const { recorder, committed } = fakeDatabase();
    const interceptor = new ActionRecorderInterceptor(new Reflector(), recorder, new FixedClock());
    await run(interceptor, requestOf('GET', '/api/v1/employees/:empId/documents/:documentId/download', { empId: 'ACV-0011', documentId: 'd1' }));
    await run(interceptor, requestOf('GET', '/api/v1/finance/statements/export'));
    await run(interceptor, requestOf('GET', '/api/v1/payroll/payslips/:id/print', { id: 'p1' }));
    await run(interceptor, requestOf('GET', '/api/v1/employees/:empId/basic', { empId: 'ACV-0011' })); // a read: nothing
    expect(recorder.pending()).toBe(3);
    await recorder.flush();
    expect(committed.events.map((e) => [e.action, e.module])).toEqual([
      ['download', 'People'],
      ['export', 'Statements'],
      ['print', 'Payroll'],
    ]);
    expect(committed.events[0]).toMatchObject({ description: 'Downloaded a document of ACV-0011', target: 'ACV-0011', employeeId: 'emp-1' });
  });

  it('leaves out anonymous requests and the Module 2 routes that arrive as events instead', async () => {
    const { recorder } = fakeDatabase();
    const interceptor = new ActionRecorderInterceptor(new Reflector(), recorder, new FixedClock());
    await run(interceptor, requestOf('POST', '/api/v1/tasks', {}, { actor: undefined }));
    await run(interceptor, requestOf('POST', '/api/v1/auth/logout'));
    await run(interceptor, requestOf('GET', '/api/v1/health'));
    expect(recorder.pending()).toBe(0);
  });
});
