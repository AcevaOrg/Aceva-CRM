import { describe, expect, it } from 'vitest';
import { FINANCE_IDLE_LIMIT_MS, IDLE_LIMIT_MS, IDLE_LOGOUT_TOLERANCE_MS, idleLimitMs, idleLogoutIsGenuine } from './session-limits';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 14, 10, 0, 0);
const idleFor = (ms: number, financeScreen: boolean) => idleLogoutIsGenuine({ nowMs: NOW, lastActiveAtMs: NOW - ms, financeScreen });

describe('session limits', () => {
  it('are 30 minutes normally and 10 on a finance screen', () => {
    expect(idleLimitMs(false)).toBe(IDLE_LIMIT_MS);
    expect(idleLimitMs(true)).toBe(FINANCE_IDLE_LIMIT_MS);
    expect(IDLE_LIMIT_MS).toBe(30 * MINUTE);
    expect(FINANCE_IDLE_LIMIT_MS).toBe(10 * MINUTE);
  });

  it('the tolerance covers a heartbeat that reports use up to a minute after the last key press, plus the 5-second countdown', () => {
    expect(IDLE_LOGOUT_TOLERANCE_MS).toBeGreaterThanOrEqual(MINUTE + 5_000);
  });
});

describe('an idle logout claimed by the browser', () => {
  it('is believed once the session was idle for the limit (30 minutes) less the tolerance', () => {
    expect(idleFor(30 * MINUTE, false)).toBe(true);
    expect(idleFor(29 * MINUTE + 33_000, false)).toBe(true); // a heartbeat 27 seconds after the last key press, then the 30-minute countdown
    expect(idleFor(28 * MINUTE, false)).toBe(true); // exactly the limit less the tolerance
    expect(idleFor(28 * MINUTE - 1, false)).toBe(false);
  });

  it('uses 10 minutes on a finance screen', () => {
    expect(idleFor(10 * MINUTE, true)).toBe(true);
    expect(idleFor(8 * MINUTE, true)).toBe(true);
    expect(idleFor(8 * MINUTE - 1, true)).toBe(false);
    expect(idleFor(8 * MINUTE, false)).toBe(false); // the same 8 minutes is far too early on a normal screen
  });

  it('is refused when the person was active moments ago', () => {
    expect(idleFor(0, false)).toBe(false);
    expect(idleFor(MINUTE, false)).toBe(false);
    expect(idleFor(5 * MINUTE, true)).toBe(false);
  });

  it('is refused for a last-active time in the future', () => {
    expect(idleLogoutIsGenuine({ nowMs: NOW, lastActiveAtMs: NOW + 5 * MINUTE, financeScreen: false })).toBe(false);
  });
});
