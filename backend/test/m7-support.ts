import type { Client, TestApp } from './helpers/app';
import { pkInstant } from '../src/common/pakistan-time';

/**
 * Module 7 tests move the clock forward through days (check-in at 09:15, the missed check-out job at 18:00, the next day...).
 * Sessions end after 30 idle minutes, and a 2FA code can never be used for an older time step, so the clock only ever moves
 * FORWARD in these files, and a person is signed in again whenever their session would have timed out.
 */
export function m7Personas(t: TestApp) {
  const cache = new Map<string, { client: Client; last: number; created: number }>();
  return async function as(empId: string): Promise<Client> {
    const now = t.clock.now().getTime();
    const known = cache.get(empId);
    if (known && now >= known.last && now - known.last < 20 * 60_000 && now - known.created < 11 * 3600_000) {
      known.last = now;
      return known.client;
    }
    const client = await t.signIn(empId);
    const after = t.clock.now().getTime();
    cache.set(empId, { client, last: after, created: after });
    return client;
  };
}

/** Moves the fake clock to a Pakistan day and time ('HH:MM'). Refuses to go back in time (see above). */
export function pkAt(t: TestApp, day: string, clock: string, seconds = 0): Date {
  const [h, m] = clock.split(':').map(Number);
  const instant = new Date(pkInstant(day, h * 60 + m).getTime() + seconds * 1000);
  const now = t.clock.now().getTime();
  if (instant.getTime() < now - 120_000) throw new Error(`The clock may only move forward in M7 tests (asked for ${day} ${clock})`);
  // A sign-in with 2FA may have nudged the clock up to 30 seconds ahead: never step back (a used 2FA step cannot be reused).
  if (instant.getTime() > now) t.clock.set(instant);
  return t.clock.now();
}

export const API = '/api/v1';
