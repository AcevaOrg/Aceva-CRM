/**
 * Pure Module 7 rules (plan section 11). No database, so they are unit-tested directly (attendance-rules.test.ts).
 * All days are Pakistan days ('YYYY-MM-DD'); minutes are minutes after midnight in Pakistan.
 */

export interface ScheduleRule {
  startMinute: number;
  endMinute: number;
  graceMinutes: number;
  workingWeekdays: number[];
  officeOnlyCheckIn: boolean;
}

/**
 * Minutes late for a check-in at `minuteOfDay`: 0 up to and including start + grace (so 09:15 with a 09:00 start and 15 minutes
 * grace is on time), then the minutes after start + grace. A check-in on a day that is not a working day is never late.
 */
export function lateMinutesFor(minuteOfDay: number, schedule: Pick<ScheduleRule, 'startMinute' | 'graceMinutes'>, workingDay: boolean): number {
  if (!workingDay) return 0;
  const limit = schedule.startMinute + schedule.graceMinutes;
  return minuteOfDay > limit ? minuteOfDay - limit : 0;
}

/** 'HH:MM' for minutes after midnight. */
export function clockOf(minute: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(minute)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Minutes after midnight for 'HH:MM'. */
export function minuteOf(clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
}

/** An IPv4 address as a 32-bit unsigned number, or null when the text is not an IPv4 address ('::ffff:' prefixes are accepted). */
export function ipv4ToNumber(ip: string | null | undefined): number | null {
  if (!ip) return null;
  const text = ip.trim().replace(/^::ffff:/i, '');
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/** Is `ip` inside `cidr`? `cidr` is a single IPv4 address (exact match) or an IPv4 range like 203.0.113.0/24. */
export function ipInCidr(ip: string | null | undefined, cidr: string): boolean {
  const address = ipv4ToNumber(ip);
  if (address === null) return false;
  const [base, bitsText] = cidr.trim().split('/');
  const network = ipv4ToNumber(base);
  if (network === null) return false;
  const bits = bitsText === undefined ? 32 : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const size = 2 ** (32 - bits);
  return Math.floor(address / size) === Math.floor(network / size);
}

/**
 * Office-only check-in (plan section 11, "management decides"): only when the schedule switches it on AND the person's office has
 * networks configured; an office without networks (for example Remote) is not restricted.
 */
export function checkInAllowedFrom(ip: string | null | undefined, officeOnly: boolean, officeNetworks: string[]): boolean {
  if (!officeOnly || officeNetworks.length === 0) return true;
  return officeNetworks.some((cidr) => ipInCidr(ip, cidr));
}

/** Leave days for a range: working days counted, a half day is 0.5 (single working day only). */
export function leaveDaysFor(workingDayCount: number, halfDay: boolean): number {
  if (halfDay) return workingDayCount === 1 ? 0.5 : 0;
  return workingDayCount;
}

/** Calendar-year leave year (development default, docs/M7-M9-DECISIONS.md). */
export function leaveYearOf(day: string): number {
  return Number(day.slice(0, 4));
}

/** Average of clock minutes, as 'HH:MM' (null for none). */
export function averageClock(minutes: number[]): string | null {
  if (!minutes.length) return null;
  return clockOf(minutes.reduce((a, b) => a + b, 0) / minutes.length);
}
