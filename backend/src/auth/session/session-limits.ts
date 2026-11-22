/** The fixed session limits (plan section 6). Pure values and rules: no Nest, no database. */
export const IDLE_LIMIT_MS = 30 * 60_000; // normal screens
export const FINANCE_IDLE_LIMIT_MS = 10 * 60_000; // finance screens
export const MAX_SESSION_MS = 12 * 3_600_000; // in any case

/**
 * The browser counts idle time from the last mouse or key press; the server from the last request that counted as
 * activity. A "still here" heartbeat that reports use can move the server's time up to a minute past the last press,
 * and the browser checks its countdown every 5 seconds. So when the browser says "I logged out for being idle", the
 * server believes it if the session was idle for at least the limit minus this much.
 */
export const IDLE_LOGOUT_TOLERANCE_MS = 2 * 60_000;

export function idleLimitMs(financeScreen: boolean): number {
  return financeScreen ? FINANCE_IDLE_LIMIT_MS : IDLE_LIMIT_MS;
}

/**
 * Is the browser's "I logged out because I was idle" believable? True when the session was idle for at least the limit
 * (10 minutes on a finance screen, 30 otherwise) minus the tolerance. A person who clicks log out a minute after their
 * last click, with a script that says "idle", is recorded as a normal clicked logout.
 */
export function idleLogoutIsGenuine(input: { nowMs: number; lastActiveAtMs: number; financeScreen: boolean }): boolean {
  return input.nowMs - input.lastActiveAtMs >= idleLimitMs(input.financeScreen) - IDLE_LOGOUT_TOLERANCE_MS;
}
