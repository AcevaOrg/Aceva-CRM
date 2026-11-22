/** Retry rules of the outbox dispatcher. Pure functions (unit-tested without a database). */

/** After this many failed deliveries the dispatcher stops trying; the row stays with processed_at empty and last_error set. */
export const OUTBOX_MAX_ATTEMPTS = 10;
/** A dispatcher holds a claimed event this long; if its server dies, another server takes the event after it. */
export const OUTBOX_LEASE_MS = 2 * 60_000;
/** How many events one claim takes. */
export const OUTBOX_BATCH = 50;

const RETRY_DELAYS_MS = [10_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];

/** The wait before the next try, after `attempts` tries so far (1 = after the first failure). */
export function outboxRetryDelayMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[i];
}

/** "auth.login:1": how the dispatcher matches an event to the consumers registered for its type and version. */
export function eventKey(type: string, version: number): string {
  return `${type}:${version}`;
}

/**
 * One consumer call may take this long. Then the try counts as failed ("timed out"), the event is retried later like
 * any failure, and the dispatcher moves on. Without it one consumer waiting for a dead mail server would hold up every
 * event of every module for minutes. Several calls per event must fit inside OUTBOX_LEASE_MS (the dispatcher also
 * renews the lease of the events it still holds).
 */
export const OUTBOX_CONSUMER_TIMEOUT_MS = 20_000;
/** A consumer call that FAILED after at least this long (a timeout, a mail server that answers slowly) pauses that consumer. */
export const OUTBOX_SLOW_FAILURE_MS = 5_000;
/**
 * A paused consumer is not called for this long: its events wait (and are not counted as failed tries) while the other
 * consumers and events carry on. After the pause one call is tried again.
 */
export const OUTBOX_SLOW_CONSUMER_PAUSE_MS = 60_000;

/** A consumer did not answer within OUTBOX_CONSUMER_TIMEOUT_MS. The call itself may still be running. */
export class ConsumerTimeoutError extends Error {
  constructor(public readonly consumer: string, ms: number) {
    super(`timed out after ${Math.round(ms / 1000)} s`);
    this.name = 'ConsumerTimeoutError';
  }
}

/**
 * Runs `work`, but stops waiting for it after `ms`: the returned promise then fails with `onTimeout()`. The work is not
 * cancelled (nothing can cancel a mail being sent), so whatever it does must be safe to repeat; its late result, or its
 * late failure, is ignored.
 */
export function withTimeout<T>(work: () => Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(onTimeout());
    }, ms);
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      settle();
    };
    let running: Promise<T>;
    try {
      running = work();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    running.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** Which consumers are paused (see OUTBOX_SLOW_CONSUMER_PAUSE_MS), kept in memory per server. */
export class SlowConsumerPause {
  private readonly until = new Map<string, number>();

  constructor(private readonly pauseMs: number = OUTBOX_SLOW_CONSUMER_PAUSE_MS) {}

  pause(consumer: string, now: Date): void {
    this.until.set(consumer, now.getTime() + this.pauseMs);
  }

  /** Until when the consumer is paused, or null when it may be called now. */
  pausedUntil(consumer: string, now: Date): Date | null {
    const until = this.until.get(consumer);
    if (until === undefined) return null;
    if (until <= now.getTime()) {
      this.until.delete(consumer);
      return null;
    }
    return new Date(until);
  }
}
