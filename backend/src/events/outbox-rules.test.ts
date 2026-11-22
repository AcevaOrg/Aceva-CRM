import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConsumerTimeoutError,
  eventKey,
  OUTBOX_CONSUMER_TIMEOUT_MS,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_SLOW_CONSUMER_PAUSE_MS,
  OUTBOX_SLOW_FAILURE_MS,
  outboxRetryDelayMs,
  SlowConsumerPause,
  withTimeout,
} from './outbox-rules';

describe('outbox dispatcher retry rules', () => {
  it('waits longer after each failure, up to 12 hours', () => {
    expect(outboxRetryDelayMs(1)).toBe(10_000);
    expect(outboxRetryDelayMs(2)).toBe(30_000);
    expect(outboxRetryDelayMs(3)).toBe(120_000);
    expect(outboxRetryDelayMs(9)).toBe(12 * 3_600_000);
    expect(outboxRetryDelayMs(50)).toBe(12 * 3_600_000);
    expect(outboxRetryDelayMs(0)).toBe(10_000);
    const delays = Array.from({ length: OUTBOX_MAX_ATTEMPTS }, (_, i) => outboxRetryDelayMs(i + 1));
    expect([...delays].sort((a, b) => a - b)).toEqual(delays); // never shorter than the one before
  });

  it('gives up after a bounded number of tries, and a crashed claim runs out in minutes', () => {
    expect(OUTBOX_MAX_ATTEMPTS).toBe(10);
    expect(OUTBOX_LEASE_MS).toBe(120_000);
  });

  it('matches consumers by type AND version', () => {
    expect(eventKey('auth.login', 1)).toBe('auth.login:1');
    expect(eventKey('auth.login', 2)).not.toBe(eventKey('auth.login', 1));
  });
});

describe('consumer time limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the result or the error of work that finishes in time', async () => {
    await expect(withTimeout(async () => 42, 1000, () => new Error('late'))).resolves.toBe(42);
    await expect(withTimeout(async () => Promise.reject(new Error('refused')), 1000, () => new Error('late'))).rejects.toThrow('refused');
    await expect(
      withTimeout(
        () => {
          throw new Error('not even async');
        },
        1000,
        () => new Error('late'),
      ),
    ).rejects.toThrow('not even async');
    expect(vi.getTimerCount()).toBe(0); // no timer is left running
  });

  it('stops waiting after the limit and ignores what the work does later', async () => {
    let finish: (value: string) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const slow = withTimeout(() => new Promise<string>((resolve) => (finish = resolve)), 1000, () => new ConsumerTimeoutError('test.mail', 1000));
    const outcome = slow.then(
      () => 'resolved',
      (error: Error) => error,
    );
    await vi.advanceTimersByTimeAsync(1000);
    const error = await outcome;
    expect(error).toBeInstanceOf(ConsumerTimeoutError);
    expect((error as Error).message).toBe('timed out after 1 s');
    finish('too late'); // nothing happens, nothing throws

    const failing = withTimeout(() => new Promise<string>((_, reject) => (fail = reject)), 1000, () => new Error('timed out'));
    const failingOutcome = failing.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await failingOutcome).toBe('timed out');
    fail(new Error('late failure')); // would be an unhandled rejection if it were not caught
    await vi.advanceTimersByTimeAsync(10);
  });

  it('pauses a slow consumer for a while, then lets it try again', () => {
    const pause = new SlowConsumerPause();
    const t0 = new Date('2030-01-01T10:00:00.000Z');
    expect(pause.pausedUntil('activity.alert-mail', t0)).toBeNull();
    pause.pause('activity.alert-mail', t0);
    expect(pause.pausedUntil('activity.alert-mail', new Date(t0.getTime() + 1000))?.getTime()).toBe(t0.getTime() + OUTBOX_SLOW_CONSUMER_PAUSE_MS);
    expect(pause.pausedUntil('activity.auth', t0)).toBeNull(); // only that consumer
    expect(pause.pausedUntil('activity.alert-mail', new Date(t0.getTime() + OUTBOX_SLOW_CONSUMER_PAUSE_MS))).toBeNull();
    expect(pause.pausedUntil('activity.alert-mail', t0)).toBeNull(); // forgotten once over
  });

  it('keeps several consumer calls of one event inside the claim, and a time-out above the "slow" mark', () => {
    expect(OUTBOX_CONSUMER_TIMEOUT_MS * 4).toBeLessThan(OUTBOX_LEASE_MS);
    expect(OUTBOX_SLOW_FAILURE_MS).toBeLessThan(OUTBOX_CONSUMER_TIMEOUT_MS);
    expect(OUTBOX_SLOW_CONSUMER_PAUSE_MS).toBeGreaterThan(OUTBOX_CONSUMER_TIMEOUT_MS);
  });
});
