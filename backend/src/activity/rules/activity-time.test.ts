import { describe, expect, it } from 'vitest';
import {
  computeDayActivity,
  dayWindow,
  daysBetween,
  effectiveEnd,
  pakistanDay,
  previousDay,
  sessionStateNow,
  type SessionSpan,
  type Signal,
} from './activity-time';

const DAY = '2026-11-10';
const NEXT = '2026-11-11';
/** A moment in Pakistan time, e.g. pk('09:05') or pk('23:50:30'). */
const pk = (time: string, day = DAY) => new Date(`${day}T${time.length === 5 ? `${time}:00` : time}+05:00`);
const window = (day = DAY) => {
  const { start, end } = dayWindow(day);
  return { dayStart: start, dayEnd: end };
};

const session = (id: string, from: Date, to: Date | null, reason: string | null = to ? 'user' : null, lastActiveAt = from): SessionSpan => ({
  id,
  startedAt: from,
  endedAt: to,
  endReason: reason,
  lastActiveAt,
});

/**
 * Heartbeats every minute from `from` + 1 minute up to and including `to` (each one describes the minute before it).
 * `quiet` lists minute starts (in the same day format) whose heartbeat reports no use.
 */
function beats(sessionId: string, from: Date, to: Date, quiet: (minuteStart: Date) => boolean = () => false): Signal[] {
  const out: Signal[] = [];
  for (let t = from.getTime() + 60_000; t <= to.getTime(); t += 60_000) {
    const minuteStart = new Date(t - 60_000);
    out.push({ sessionId, at: new Date(t), kind: 'heartbeat', active: !quiet(minuteStart) });
  }
  return out;
}
const between = (a: Date, b: Date) => (m: Date) => m.getTime() >= a.getTime() && m.getTime() < b.getTime();

describe('Pakistan days', () => {
  it('a day runs from 00:00 to 24:00 Pakistan time (UTC+5, no daylight saving)', () => {
    expect(dayWindow(DAY).start.toISOString()).toBe('2026-11-09T19:00:00.000Z');
    expect(dayWindow(DAY).end.toISOString()).toBe('2026-11-10T19:00:00.000Z');
    expect(pakistanDay(new Date('2026-11-10T18:59:59.999Z'))).toBe(DAY);
    expect(pakistanDay(new Date('2026-11-10T19:00:00.000Z'))).toBe(NEXT);
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(daysBetween(NEXT, DAY)).toEqual([]);
  });
});

describe('active and idle time', () => {
  const now = pk('20:00');

  it('a fully used hour is 60 active minutes, from the login to the clicked log-out', () => {
    const s = session('a', pk('09:00'), pk('10:00'));
    const day = computeDayActivity({ sessions: [s], signals: beats('a', pk('09:00'), pk('10:00')), now, ...window() });
    expect(day).toMatchObject({ activeMinutes: 60, idleMinutes: 0, sessions: 1, idleSpans: [] });
    expect(day.firstLoginAt?.toISOString()).toBe(pk('09:00').toISOString());
    expect(day.lastLogoutAt?.toISOString()).toBe(pk('10:00').toISOString());
  });

  it('five quiet minutes in a row are idle; four are still active (a short pause)', () => {
    const s = session('a', pk('09:00'), pk('10:00'));
    const fiveQuiet = beats('a', pk('09:00'), pk('10:00'), between(pk('09:10'), pk('09:15')));
    const five = computeDayActivity({ sessions: [s], signals: fiveQuiet, now, ...window() });
    expect(five).toMatchObject({ activeMinutes: 55, idleMinutes: 5 });
    expect(five.idleSpans.map((i) => [i.from.toISOString(), i.to.toISOString()])).toEqual([[pk('09:10').toISOString(), pk('09:15').toISOString()]]);

    const fourQuiet = beats('a', pk('09:00'), pk('10:00'), between(pk('09:10'), pk('09:14')));
    expect(computeDayActivity({ sessions: [s], signals: fourQuiet, now, ...window() })).toMatchObject({ activeMinutes: 60, idleMinutes: 0 });
  });

  it('a whole quiet stretch is idle, from its first quiet minute (not only after 5 minutes)', () => {
    const s = session('a', pk('09:00'), pk('10:00'));
    const signals = beats('a', pk('09:00'), pk('10:00'), between(pk('09:20'), pk('09:45')));
    expect(computeDayActivity({ sessions: [s], signals, now, ...window() })).toMatchObject({ activeMinutes: 35, idleMinutes: 25 });
  });

  it('a closed laptop: the signals stop, so the last signal is the logout time, not the later 30-minute timeout', () => {
    const s = session('a', pk('09:00'), pk('11:31'), 'idle_timeout');
    const day = computeDayActivity({ sessions: [s], signals: beats('a', pk('09:00'), pk('11:00')), now, ...window() });
    expect(day).toMatchObject({ activeMinutes: 120, idleMinutes: 0 });
    expect(day.lastLogoutAt?.toISOString()).toBe(pk('11:00').toISOString());
  });

  it('a gap in the signals inside a session (laptop shut for 10 minutes, then opened again) is idle', () => {
    const s = session('a', pk('09:00'), pk('10:00'));
    const signals = [...beats('a', pk('09:00'), pk('09:30')), ...beats('a', pk('09:40'), pk('10:00'))];
    expect(computeDayActivity({ sessions: [s], signals, now, ...window() })).toMatchObject({ activeMinutes: 50, idleMinutes: 10 });
  });

  it('a forced logout after the person had already stopped: their time ends at their last signal', () => {
    const s = session('a', pk('09:00'), pk('10:45'), 'forced');
    const day = computeDayActivity({ sessions: [s], signals: beats('a', pk('09:00'), pk('10:00')), now, ...window() });
    expect(day.activeMinutes).toBe(60);
    expect(day.lastLogoutAt?.toISOString()).toBe(pk('10:00').toISOString());
  });

  it('a clicked log-out a little after the last heartbeat ends the session at the click', () => {
    const s = session('a', pk('09:00'), pk('09:59:40'));
    const day = computeDayActivity({ sessions: [s], signals: beats('a', pk('09:00'), pk('09:59')), now, ...window() });
    expect(day.lastLogoutAt?.toISOString()).toBe(pk('09:59:40').toISOString());
    expect(day.activeMinutes).toBe(60); // 09:00 to 10:00, rounded to whole minutes
  });

  it('a silent laptop signed out from the phone 25 minutes later ends at its last signal, like a timeout', () => {
    const signals = beats('a', pk('09:00'), pk('10:00')); // the laptop is shut at 10:00
    const fromPhone = computeDayActivity({ sessions: [session('a', pk('09:00'), pk('10:25'), 'user_other_device', pk('10:00'))], signals, now, ...window() });
    expect(fromPhone).toMatchObject({ activeMinutes: 60, idleMinutes: 0, idleSpans: [] });
    expect(fromPhone.lastLogoutAt?.toISOString()).toBe(pk('10:00').toISOString());

    const timedOut = computeDayActivity({ sessions: [session('a', pk('09:00'), pk('10:25'), 'idle_timeout', pk('10:00'))], signals, now, ...window() });
    expect(fromPhone).toEqual(timedOut);

    // The same end clicked in the session itself ("user") is a signal from the person, so the time runs to the click.
    const clicked = computeDayActivity({ sessions: [session('a', pk('09:00'), pk('10:25'), 'user', pk('10:00'))], signals, now, ...window() });
    expect(clicked.lastLogoutAt?.toISOString()).toBe(pk('10:25').toISOString());
    expect(clicked.activeMinutes + clicked.idleMinutes).toBe(85);
  });

  it('a session ended from another device ignores signals that reach the server after it was ended', () => {
    const s = session('a', pk('09:00'), pk('09:30'), 'user_other_device', pk('09:00'));
    // Heartbeats up to 09:40 (a late request from the old tab) are after the end, so they are ignored.
    const day = computeDayActivity({ sessions: [s], signals: beats('a', pk('09:00'), pk('09:40')), now, ...window() });
    expect(day.lastLogoutAt?.toISOString()).toBe(pk('09:30').toISOString());
    expect(day).toMatchObject({ activeMinutes: 30, idleMinutes: 0 });
  });

  it('overlapping sessions (two tabs or two devices) are never counted twice', () => {
    const a = session('a', pk('09:00'), pk('10:00'));
    const b = session('b', pk('09:30'), pk('10:30'));
    const signals = [...beats('a', pk('09:00'), pk('10:00')), ...beats('b', pk('09:30'), pk('10:30'))];
    const day = computeDayActivity({ sessions: [a, b], signals, now, ...window() });
    expect(day).toMatchObject({ activeMinutes: 90, idleMinutes: 0, sessions: 2 });
    expect(day.lastLogoutAt?.toISOString()).toBe(pk('10:30').toISOString());
  });

  it('with two sessions open, a minute is active if either shows use', () => {
    const a = session('a', pk('09:00'), pk('10:00'));
    const b = session('b', pk('09:00'), pk('10:00'));
    const quietA = beats('a', pk('09:00'), pk('10:00'), () => true); // a background tab, never used
    const usedB = beats('b', pk('09:00'), pk('10:00'), between(pk('09:30'), pk('09:40')));
    expect(computeDayActivity({ sessions: [a, b], signals: [...quietA, ...usedB], now, ...window() })).toMatchObject({ activeMinutes: 50, idleMinutes: 10 });
  });

  it('a session over midnight is split between the two days', () => {
    const s = session('a', pk('23:50'), pk('00:20', NEXT));
    const signals = beats('a', pk('23:50'), pk('00:20', NEXT));
    const later = pk('12:00', NEXT);
    const first = computeDayActivity({ sessions: [s], signals, now: later, ...window(DAY) });
    const second = computeDayActivity({ sessions: [s], signals, now: later, ...window(NEXT) });
    expect(first).toMatchObject({ activeMinutes: 10, idleMinutes: 0 });
    expect(first.firstLoginAt?.toISOString()).toBe(pk('23:50').toISOString());
    expect(first.lastLogoutAt?.toISOString()).toBe(dayWindow(DAY).end.toISOString()); // still signed in at midnight
    expect(second).toMatchObject({ activeMinutes: 20, idleMinutes: 0 });
    expect(second.firstLoginAt?.toISOString()).toBe(dayWindow(NEXT).start.toISOString()); // carried over from the evening
    expect(second.lastLogoutAt?.toISOString()).toBe(pk('00:20', NEXT).toISOString());
  });

  it('a quiet stretch across midnight is judged as a whole, then split', () => {
    const s = session('a', pk('23:40'), pk('00:20', NEXT));
    const signals = beats('a', pk('23:40'), pk('00:20', NEXT), between(pk('23:58'), pk('00:03', NEXT)));
    const later = pk('12:00', NEXT);
    expect(computeDayActivity({ sessions: [s], signals, now: later, ...window(DAY) })).toMatchObject({ activeMinutes: 18, idleMinutes: 2 });
    expect(computeDayActivity({ sessions: [s], signals, now: later, ...window(NEXT) })).toMatchObject({ activeMinutes: 17, idleMinutes: 3 });
  });

  it('today, with a live session: no logout yet ("still signed in")', () => {
    const s = session('a', pk('09:00'), null);
    const day = computeDayActivity({ sessions: [s], signals: beats('a', pk('09:00'), pk('10:59')), now: pk('11:00'), ...window() });
    expect(day.lastLogoutAt).toBeNull();
    expect(day.activeMinutes).toBe(119);
  });

  it('ignores signals before the login and after the logout', () => {
    const s = session('a', pk('09:00'), pk('10:00'));
    const stray: Signal[] = [
      { sessionId: 'a', at: pk('08:30'), kind: 'heartbeat', active: true },
      { sessionId: 'a', at: pk('10:30'), kind: 'action', active: true },
    ];
    const day = computeDayActivity({ sessions: [s], signals: [...beats('a', pk('09:00'), pk('10:00')), ...stray], now, ...window() });
    expect(day.activeMinutes + day.idleMinutes).toBe(60);
    expect(day.lastLogoutAt?.toISOString()).toBe(pk('10:00').toISOString());
  });

  it('without heartbeats (an old client) only the login, actions and the log-out show use; the rest is idle', () => {
    const s = session('a', pk('09:00'), pk('10:00'));
    const actions: Signal[] = [{ sessionId: 'a', at: pk('09:30:10'), kind: 'action', active: true }];
    expect(computeDayActivity({ sessions: [s], signals: actions, now, ...window() })).toMatchObject({ activeMinutes: 3, idleMinutes: 57 });
  });

  it('a day with no session at all is empty', () => {
    expect(computeDayActivity({ sessions: [], signals: [], now, ...window() })).toEqual({
      firstLoginAt: null,
      lastLogoutAt: null,
      activeMinutes: 0,
      idleMinutes: 0,
      segments: [],
      idleSpans: [],
      sessions: 0,
    });
  });

  it('a session on another day does not count', () => {
    const s = session('a', pk('09:00', NEXT), pk('10:00', NEXT));
    expect(computeDayActivity({ sessions: [s], signals: beats('a', pk('09:00', NEXT), pk('10:00', NEXT)), now: pk('20:00', NEXT), ...window(DAY) }).sessions).toBe(0);
  });

  it('a very short session (under half a minute) is a login but no minutes', () => {
    const s = session('a', pk('09:00:00'), pk('09:00:20'));
    expect(computeDayActivity({ sessions: [s], signals: [], now, ...window() })).toMatchObject({ activeMinutes: 0, idleMinutes: 0, sessions: 1 });
  });

  it('segments cover the day in order, alternating active and idle', () => {
    const s = session('a', pk('09:00'), pk('10:00'));
    const day = computeDayActivity({ sessions: [s], signals: beats('a', pk('09:00'), pk('10:00'), between(pk('09:20'), pk('09:30'))), now, ...window() });
    expect(day.segments.map((x) => [x.state, x.from.toISOString(), x.to.toISOString()])).toEqual([
      ['active', pk('09:00').toISOString(), pk('09:20').toISOString()],
      ['idle', pk('09:20').toISOString(), pk('09:30').toISOString()],
      ['active', pk('09:30').toISOString(), pk('10:00').toISOString()],
    ]);
  });
});

describe('session end and the online state', () => {
  it('a live session ends (for time accounting) at its last signal', () => {
    const s = session('a', pk('09:00'), null, null, pk('09:20'));
    expect(effectiveEnd(s, beats('a', pk('09:00'), pk('09:40')), pk('09:41')).toISOString()).toBe(pk('09:40').toISOString());
    expect(effectiveEnd(s, [], pk('09:41')).toISOString()).toBe(pk('09:20').toISOString());
  });

  it('is active with use in the last 5 minutes, otherwise idle', () => {
    expect(sessionStateNow(pk('09:56'), pk('10:00'))).toBe('active');
    expect(sessionStateNow(pk('09:55'), pk('10:00'))).toBe('idle');
    expect(sessionStateNow(null, pk('10:00'))).toBe('idle');
  });
});
