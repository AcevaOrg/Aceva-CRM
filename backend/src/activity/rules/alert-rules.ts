/**
 * Security alert rules (plan section 8, "Alerts the system raises"). Pure functions: no Nest, no database.
 *   - an account locked after 5 wrong passwords
 *   - a login from a new device or a new city
 *   - a login outside working hours (the hours come from settings)
 *   - a large export of finance or employee data; many salary records opened in a short time
 *   - repeated attempts to open finance screens without permission
 */
import { z } from 'zod';
import type { AlertKindName, AlertSeverityName } from '@aceva/contracts';
import { PKT_OFFSET_MS } from './activity-time';
import { plainIp } from './ip-ranges';

/**
 * The "alert-rules" settings section (system_settings). These defaults apply while no row exists; they are the values the
 * Settings screen shows (frontend mocks/seed/system.ts). Module 12 builds the screen that changes them.
 */
export interface AlertRuleSettings {
  newDevice: boolean;
  newCity: boolean;
  outsideHours: boolean;
  /** The "outside working hours" window in Pakistan time: from 20:00 to 07:00 means 20:00 at night until 07:00 next morning. */
  outsideFrom: string;
  outsideTo: string;
  largeExportRows: number;
  salaryViewsPerHour: number;
  financeAttempts: number;
}

export const ALERT_RULE_DEFAULTS: AlertRuleSettings = {
  newDevice: true,
  newCity: true,
  outsideHours: true,
  outsideFrom: '20:00',
  outsideTo: '07:00',
  largeExportRows: 500,
  salaryViewsPerHour: 5,
  financeAttempts: 3,
};

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time like 20:00');

/** Validates a stored settings row. Unknown keys (other sections' fields, Module 16 thresholds) are kept but ignored. */
export const alertRuleSettingsSchema = z
  .object({
    newDevice: z.boolean(),
    newCity: z.boolean(),
    outsideHours: z.boolean(),
    outsideFrom: clockTime,
    outsideTo: clockTime,
    largeExportRows: z.number().int().min(1),
    salaryViewsPerHour: z.number().int().min(1),
    financeAttempts: z.number().int().min(1),
  })
  .passthrough();

/** "Repeated" finance attempts are counted in this window. */
export const FINANCE_ATTEMPT_WINDOW_MIN = 15;
/** "Many salary records in a short time" is counted per hour (the setting is "in one hour"). */
export const SALARY_VIEW_WINDOW_MIN = 60;
/**
 * A person raises at most one large-export alert per kind of data (finance, employee) in this window, however many large
 * exports follow. Every export is still recorded in the activity log; only the alert (and its mail) is not repeated.
 */
export const LARGE_EXPORT_WINDOW_MIN = 60;
/**
 * Alerts are only raised for fresh events. When Module 4 is first switched on it also turns the old login events in
 * the outbox into activity records, but it does not raise alerts about logins from last month.
 */
export const ALERT_MAX_AGE_MS = 24 * 3_600_000;

/** Sensitive-view categories that count as "salary records" (salary, bank details, payslips). */
export const SALARY_CATEGORIES = ['salary', 'bank', 'payslip'] as const;
export type SensitiveCategory = (typeof SALARY_CATEGORIES)[number] | 'personal' | 'finance_statement';

/** HH:MM in Pakistan time. */
export function pakistanClock(at: Date): string {
  return new Date(at.getTime() + PKT_OFFSET_MS).toISOString().slice(11, 16);
}

/**
 * Inside the "outside working hours" window? The window may run over midnight (20:00 to 07:00). An empty window
 * (from equals to) never matches.
 */
export function isOutsideWorkingHours(at: Date, from: string, to: string): boolean {
  const t = pakistanClock(at);
  if (from === to) return false;
  return from < to ? t >= from && t < to : t >= from || t < to;
}

export interface SignInPlace {
  fingerprint: string;
  city: string | null;
}

/**
 * Is this sign-in from a device or a city the person has not used before? The very first sign-in sets the baseline and
 * raises nothing. A city is only "new" when it is known and the person has signed in from a known city before.
 */
export function newSignIn(previous: SignInPlace[], current: SignInPlace): { newDevice: boolean; newCity: boolean } {
  if (!previous.length) return { newDevice: false, newCity: false };
  const newDevice = !previous.some((p) => p.fingerprint === current.fingerprint);
  const knownCities = new Set(previous.map((p) => p.city?.trim().toLowerCase()).filter((c): c is string => !!c));
  const city = current.city?.trim().toLowerCase();
  const newCity = !!city && knownCities.size > 0 && !knownCities.has(city);
  return { newDevice, newCity };
}

export interface AlertText {
  kind: AlertKindName;
  rule: string;
  severity: AlertSeverityName;
  details: string;
}

/** The rule names and severities the alert cards show (frontend mocks use the same texts). */
export const ALERT_RULES: Record<AlertKindName | 'new_city', { rule: string; severity: AlertSeverityName }> = {
  account_locked: { rule: 'Account locked after 5 wrong passwords', severity: 'medium' },
  new_device: { rule: 'Login from a new device', severity: 'medium' },
  new_city: { rule: 'Login from a new city', severity: 'high' },
  outside_hours: { rule: 'Login outside working hours', severity: 'low' },
  large_export: { rule: 'Large export', severity: 'medium' },
  salary_views: { rule: 'Many salary records opened in a short time', severity: 'medium' },
  finance_attempts: { rule: 'Repeated attempts to open finance screens', severity: 'high' },
};

export function newSignInAlert(facts: { newDevice: boolean; newCity: boolean; device: string; city: string | null; ip: string; usualCities: string[] }): AlertText | null {
  if (!facts.newDevice && !facts.newCity) return null;
  const ip = plainIp(facts.ip);
  if (facts.newCity) {
    // The city is named once, in the first words; the part after the colon is the device and the address.
    const usual = facts.usualCities.length ? ` Usual: ${facts.usualCities.join(', ')}.` : '';
    return { kind: 'new_device', ...ALERT_RULES.new_city, details: `Signed in from ${facts.city}${facts.newDevice ? ' on a new device' : ''}: ${facts.device} (${ip}).${usual}` };
  }
  const where = `${facts.device}${facts.city ? `, ${facts.city}` : ''} (${ip})`;
  return { kind: 'new_device', ...ALERT_RULES.new_device, details: `Signed in on a device not used before: ${where}.` };
}

export function outsideHoursAlert(at: Date, facts: { city: string | null; device: string }): AlertText {
  return { kind: 'outside_hours', ...ALERT_RULES.outside_hours, details: `Signed in at ${pakistanClock(at)} (Pakistan time) from ${facts.city ?? 'an unknown city'}, ${facts.device}.` };
}

export function accountLockedAlert(facts: { attempts: number; device: string | null; city: string | null; ip: string | null }): AlertText {
  const place = [facts.device, facts.city].filter(Boolean).join(', ');
  const from = [place, facts.ip ? `(${plainIp(facts.ip)})` : null].filter(Boolean).join(' ');
  return {
    kind: 'account_locked',
    ...ALERT_RULES.account_locked,
    details: `${facts.attempts} wrong passwords${from ? `, the last from ${from}` : ''}. The account stays locked until a manager above the person unlocks it.`,
  };
}

export function largeExportAlert(facts: { rows: number; module: string; dataKind: 'finance' | 'employee' }): AlertText {
  return {
    kind: 'large_export',
    rule: `Large export of ${facts.dataKind} data`,
    severity: ALERT_RULES.large_export.severity,
    details: `${facts.rows.toLocaleString('en-US')} rows exported from ${facts.module}.`,
  };
}

export function salaryViewsAlert(facts: { count: number; minutes: number }): AlertText {
  return { kind: 'salary_views', ...ALERT_RULES.salary_views, details: `${facts.count} salary, bank or payslip records opened in ${facts.minutes} minutes.` };
}

export function financeAttemptsAlert(facts: { count: number; minutes: number; modules: string[] }): AlertText {
  return {
    kind: 'finance_attempts',
    ...ALERT_RULES.finance_attempts,
    details: `${facts.count} blocked attempts to open finance screens (${facts.modules.join(', ')}) within ${facts.minutes} minutes.`,
  };
}

/**
 * Is this record about the person's OWN Emp-ID? Showing yourself your own salary or bank number is not "opening someone's
 * records", so it never counts toward the "many salary records" alert.
 */
export function isOwnRecord(event: { target?: string | null; empId?: string }): boolean {
  return !!event.empId && event.target === event.empId;
}

/**
 * Which recorded activity an alert rule must look at (written to the outbox as activity.flagged). Pass the event's
 * `target` and the person's `empId` so that a person viewing their own pay details is not flagged.
 */
export function flagFor(event: { action: string; financeLinked: boolean; details?: unknown; target?: string | null; empId?: string }): 'finance_blocked' | 'salary_view' | 'export' | null {
  const details = (event.details && typeof event.details === 'object' ? event.details : {}) as Record<string, unknown>;
  if (event.action === 'blocked' && event.financeLinked) return 'finance_blocked';
  if (event.action === 'sensitive_view' && (SALARY_CATEGORIES as readonly string[]).includes(String(details.category))) return isOwnRecord(event) ? null : 'salary_view';
  if (event.action === 'export' && typeof details.rows === 'number') return 'export';
  return null;
}

/** A time window bucket, so a count rule raises at most one alert per person and window even when retried. */
export function windowBucket(at: Date, minutes: number): string {
  const size = minutes * 60_000;
  return new Date(Math.floor(at.getTime() / size) * size).toISOString();
}

export interface AlertViewer {
  id: string;
  roleKey: string;
  permissions: ReadonlySet<string>;
}

/**
 * Who may mark an alert as checked (frontend features/activity/logic.ts canCheckAlert):
 *  - only people who act on security (activity.security AND session.force_logout: the Director and the CTO). The
 *    CEO / Founder / Owner sees every alert but acts on none;
 *  - never an alert about yourself (maker-checker);
 *  - an alert about someone below you in your reporting line; nobody acts above the Director, so the CTO checks
 *    alerts about the Director and the Director checks alerts about the CEO / Founder / Owner.
 */
export function canCheckAlert(viewer: AlertViewer, subject: { id: string; roleKey: string }, subjectIsBelowViewer: boolean): boolean {
  if (!viewer.permissions.has('activity.security') || !viewer.permissions.has('session.force_logout')) return false;
  if (subject.id === viewer.id) return false;
  if (subjectIsBelowViewer) return true;
  return (viewer.roleKey === 'director' && subject.roleKey === 'owner') || (viewer.roleKey === 'cto' && subject.roleKey === 'director');
}
