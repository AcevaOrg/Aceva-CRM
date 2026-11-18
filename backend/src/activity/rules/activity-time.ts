/**
 * Active and idle time (plan section 8, "How it works"). Pure functions: no Nest, no database.
 *
 *  - While the app is open the browser sends a "still here" heartbeat every 60 seconds saying whether the mouse or
 *    keyboard was used in the minute BEFORE it. Screens opened and recorded actions are signals of use too.
 *  - Five minutes or more without use counts as idle: a quiet stretch of 5 minutes or more is idle from its first
 *    minute; a shorter pause (reading, thinking) counts as active.
 *  - If the signals stop (tab closed, laptop shut), the session's last signal is its end ("logout time"), even if the
 *    session itself was only ended later by the 30-minute timeout. A clicked "log out" is itself a signal, but only
 *    when it was clicked in that session (end reason "user"). A session ended from another device ("My devices", end
 *    reason "user_other_device") is not: a laptop that was shut at 10:00 and signed out from the phone at 10:25 ended
 *    at 10:00.
 *  - Time is counted in whole minutes. Two sessions open at once (two tabs, two devices) are never counted twice: the
 *    person's minutes are the union of the sessions' minutes, and a minute is active if any session shows use in it.
 *  - Days are Pakistan days (UTC+5, no daylight saving). A session over midnight is split between the two days; the
 *    5-minute rule is applied before splitting, so a quiet stretch across midnight is judged as a whole.
 */

/** Pakistan Standard Time is UTC+5 all year. */
export const PKT_OFFSET_MS = 5 * 3_600_000;
export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
/** Five minutes without mouse or keyboard use counts as idle (plan section 8). */
export const IDLE_AFTER_MINUTES = 5;

/** The Pakistan day (YYYY-MM-DD) of a moment. */
export function pakistanDay(at: Date): string {
  return new Date(at.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

/** 00:00 to 24:00 of a Pakistan day, as UTC instants ([start, end)). */
export function dayWindow(day: string): { start: Date; end: Date } {
  const start = new Date(new Date(`${day}T00:00:00.000Z`).getTime() - PKT_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** The Pakistan day before `day`. */
export function previousDay(day: string): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() - DAY_MS).toISOString().slice(0, 10);
}

/** Every Pakistan day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = new Date(`${from}T00:00:00.000Z`).getTime(), end = new Date(`${to}T00:00:00.000Z`).getTime(); t <= end; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export interface SessionSpan {
  id: string;
  startedAt: Date;
  /** When the session was ended (null = still live). */
  endedAt: Date | null;
  /**
   * Module 2's end reason. Only "user" (the person clicked log out in THIS session) is a signal from that session.
   * "user_other_device" (ended from another device), timeouts and administrator actions are not.
   */
  endReason: string | null;
  /** The last time a request that counts as activity touched the session (passive heartbeats do not). */
  lastActiveAt: Date;
}

export interface Signal {
  sessionId: string;
  at: Date;
  /**
   * heartbeat: `active` says whether the mouse or keyboard was used in the minute before `at`.
   * action: the person did something at `at` (opened a screen, saved a change); `active` is true.
   */
  kind: 'heartbeat' | 'action';
  active: boolean;
}

export type MinuteState = 'active' | 'idle';

export interface Segment {
  from: Date;
  to: Date;
  state: MinuteState;
}

export interface DayActivity {
  /** The first moment the person was signed in that day (the day's start for a session carried over from the evening). */
  firstLoginAt: Date | null;
  /** When the last session ended that day; null while the person is still signed in (today only). */
  lastLogoutAt: Date | null;
  activeMinutes: number;
  idleMinutes: number;
  /** The day, minute by minute merged into stretches, in time order. */
  segments: Segment[];
  idleSpans: Array<{ from: Date; to: Date }>;
  /** Sessions that were signed in at some point of the day. */
  sessions: number;
}

const floorMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
/** The nearest whole minute (half a minute rounds up). A minute counts when its middle lies inside the window. */
const roundMinute = (ms: number) => floorMinute(ms + MINUTE_MS / 2);

/**
 * Where a session really ends for time accounting: its last signal (or the clicked log-out), never later than the time
 * it was ended, and never in the future.
 */
export function effectiveEnd(session: SessionSpan, signals: Signal[], now: Date): Date {
  const hardEnd = Math.min(session.endedAt?.getTime() ?? now.getTime(), now.getTime());
  let last = session.startedAt.getTime();
  const consider = (t: number) => {
    if (t >= session.startedAt.getTime() && t <= hardEnd && t > last) last = t;
  };
  consider(session.lastActiveAt.getTime());
  for (const s of signals) if (s.sessionId === session.id) consider(s.at.getTime());
  if (session.endedAt && session.endReason === 'user') consider(session.endedAt.getTime());
  return new Date(Math.min(last, hardEnd));
}

/**
 * Minutes of one person, merged over all their sessions: for every minute they were signed in, whether it was active
 * or idle. Sessions and signals may reach outside the day of interest (the caller passes everything that touches it).
 */
export function personMinutes(sessions: SessionSpan[], signals: Signal[], now: Date, idleAfterMinutes = IDLE_AFTER_MINUTES): Map<number, MinuteState> {
  const used = new Map<number, boolean>(); // minute start -> mouse/keyboard used in it
  for (const session of sessions) {
    const own = signals.filter((s) => s.sessionId === session.id);
    const start = session.startedAt.getTime();
    const end = effectiveEnd(session, own, now).getTime();
    const first = roundMinute(start);
    const last = roundMinute(end) - MINUTE_MS; // the last covered minute
    if (last < first) continue; // signed in for less than half a minute
    for (let m = first; m <= last; m += MINUTE_MS) if (!used.has(m)) used.set(m, false);

    const mark = (t: number) => {
      const m = Math.min(Math.max(floorMinute(t), first), last);
      used.set(m, true);
    };
    mark(start); // signing in is use
    if (session.endedAt && session.endReason === 'user' && session.endedAt.getTime() <= end) mark(session.endedAt.getTime());
    if (session.lastActiveAt.getTime() >= start && session.lastActiveAt.getTime() <= end) mark(session.lastActiveAt.getTime());
    for (const s of own) {
      const t = s.at.getTime();
      if (t < start || t > end || !s.active) continue;
      // A heartbeat describes the minute before it; an action happens at its own moment.
      mark(s.kind === 'heartbeat' ? t - MINUTE_MS / 2 : t);
    }
  }

  // Apply the 5-minute rule over each unbroken stretch of signed-in minutes.
  const minutes = [...used.keys()].sort((a, b) => a - b);
  const state = new Map<number, MinuteState>();
  let i = 0;
  while (i < minutes.length) {
    if (used.get(minutes[i])) {
      state.set(minutes[i], 'active');
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < minutes.length && minutes[j + 1] === minutes[j] + MINUTE_MS && !used.get(minutes[j + 1])) j++;
    const quietLength = j - i + 1;
    const verdict: MinuteState = quietLength >= idleAfterMinutes ? 'idle' : 'active';
    for (let k = i; k <= j; k++) state.set(minutes[k], verdict);
    i = j + 1;
  }
  return state;
}

/** One person's day: first login, last logout, active and idle minutes and stretches. */
export function computeDayActivity(input: {
  sessions: SessionSpan[];
  signals: Signal[];
  dayStart: Date;
  dayEnd: Date;
  now: Date;
  idleAfterMinutes?: number;
}): DayActivity {
  const { sessions, signals, dayStart, dayEnd, now } = input;
  const dayFrom = dayStart.getTime();
  const dayTo = dayEnd.getTime();

  const touching = sessions
    .map((s) => ({ s, end: effectiveEnd(s, signals, now).getTime(), start: s.startedAt.getTime() }))
    .filter(({ start, end }) => start < dayTo && (end > dayFrom || start >= dayFrom));

  const state = personMinutes(
    touching.map((t) => t.s),
    signals,
    now,
    input.idleAfterMinutes ?? IDLE_AFTER_MINUTES,
  );

  const inDay = [...state.entries()].filter(([m]) => m >= dayFrom && m < dayTo).sort((a, b) => a[0] - b[0]);
  const segments: Segment[] = [];
  for (const [m, st] of inDay) {
    const prev = segments[segments.length - 1];
    if (prev && prev.state === st && prev.to.getTime() === m) prev.to = new Date(m + MINUTE_MS);
    else segments.push({ from: new Date(m), to: new Date(m + MINUTE_MS), state: st });
  }
  const activeMinutes = inDay.filter(([, st]) => st === 'active').length;
  const idleMinutes = inDay.length - activeMinutes;

  if (!touching.length) {
    return { firstLoginAt: null, lastLogoutAt: null, activeMinutes: 0, idleMinutes: 0, segments: [], idleSpans: [], sessions: 0 };
  }
  const firstLoginAt = new Date(Math.max(dayFrom, Math.min(...touching.map((t) => t.start))));
  // Still signed in: a live session on a day that is not over yet.
  const stillSignedIn = dayTo > now.getTime() && touching.some((t) => t.s.endedAt === null);
  const lastLogoutAt = stillSignedIn ? null : new Date(Math.min(dayTo, Math.max(...touching.map((t) => t.end))));
  return {
    firstLoginAt,
    lastLogoutAt,
    activeMinutes,
    idleMinutes,
    segments,
    idleSpans: segments.filter((s) => s.state === 'idle').map(({ from, to }) => ({ from, to })),
    sessions: touching.length,
  };
}

/** "Active" on the online screen: some use (mouse, keyboard, a screen, an action) in the last 5 minutes. */
export function sessionStateNow(lastUseAt: Date | null, now: Date, idleAfterMinutes = IDLE_AFTER_MINUTES): MinuteState {
  return lastUseAt && now.getTime() - lastUseAt.getTime() < idleAfterMinutes * MINUTE_MS ? 'active' : 'idle';
}
