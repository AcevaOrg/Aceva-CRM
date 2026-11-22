import { z } from 'zod';
import type { LogoutReason } from './auth';
import { ALERT_KINDS, ALERT_SEVERITIES, empIdSchema } from './events';

// ---------------------------------------------------------------------------
// Module 4: employee activity tracking (plan section 8, spec section 9.4)
// Tracking data is insert-only: there is no request that edits or deletes it.
// ---------------------------------------------------------------------------

/** Where an activity event comes from: this system, or a connected sales tool (Module 16). */
export const ACTIVITY_SOURCES = ['aceva', 'apollo', 'millionverifier', 'mailbox'] as const;
export const activitySourceSchema = z.enum(ACTIVITY_SOURCES);
export type ActivitySource = z.infer<typeof activitySourceSchema>;

/** What an activity event records. The last five are sales-tool work counts (Module 16). */
export const ACTIVITY_ACTIONS = [
  'login',
  'logout',
  'login_failed',
  'screen_view',
  'create',
  'edit',
  'delete',
  'submit',
  'assign',
  'approve',
  'reject',
  'comment',
  'upload',
  'download',
  'export',
  'print',
  'sensitive_view',
  'blocked',
  'security',
  'email_sent',
  'reply',
  'bounce',
  'call',
  'email_check',
] as const;
export const activityActionSchema = z.enum(ACTIVITY_ACTIONS);
export type ActivityActionName = z.infer<typeof activityActionSchema>;

/**
 * Every module label the server records on an activity event (backend rules/activity-classify.ts moduleOf, plus "System"
 * for a signal without a page). The activity search "Module" filter offers exactly these; an exact match finds the rows.
 */
export const ACTIVITY_MODULES = [
  'Home',
  'Login',
  'People',
  'Org',
  'Approvals',
  'Activity',
  'Tasks',
  'Performance',
  'Attendance',
  'Leave',
  'Payroll',
  'Finance',
  'Ledger',
  'Banking',
  'Bills and expenses',
  'Month close',
  'Statements',
  'Spreadsheet',
  'Insights',
  'Billing',
  'Subscriptions',
  'Settings',
  'Audit',
  'Messages',
  'Announcements',
  'Meetings',
  'Sales',
  'Integrations',
  'Notifications',
  'System',
] as const;
export type ActivityModuleName = (typeof ACTIVITY_MODULES)[number];

/**
 * GET /activity/alerts returns EVERY open alert (an open alert is never cut off) plus at most this many of the newest
 * checked ones. The screens say so when the checked list reaches this size.
 */
export const ALERTS_CHECKED_LIMIT = 500;

/** How a session ended, in the words the screens use (from M2's end reasons). */
export type LogoutHow = LogoutReason;

/** The alert rules (the lists themselves live in events.ts, next to the events that carry them). */
export type AlertKindName = (typeof ALERT_KINDS)[number];
export type AlertSeverityName = (typeof ALERT_SEVERITIES)[number];

const isoDay = z.iso.date();
/** Query strings arrive as text; an empty filter ("Any action") means no filter. */
const optionalFilter = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

// ---------- requests ----------

/** POST /activity/heartbeat: sent every 60 seconds while the app is open. Only a yes/no: was the mouse or keyboard used? */
export const heartbeatRequestSchema = z.object({ active: z.boolean() }).strict();
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

/** POST /activity/screen: one event each time a screen opens (its label, and the page path). */
export const screenViewRequestSchema = z
  .object({
    screen: z.string().trim().min(1).max(120),
    path: z.string().trim().max(300).regex(/^\//, 'A page path starts with /').optional(),
  })
  .strict();
export type ScreenViewRequest = z.infer<typeof screenViewRequestSchema>;

/**
 * GET /activity/events: activity search. Dates are days in Pakistan time (YYYY-MM-DD), both ends included. At most 2000
 * rows, newest first.
 */
export const activityEventsQuerySchema = z.object({
  empId: optionalFilter(empIdSchema),
  /** A department code, for example dep-eng. */
  departmentId: optionalFilter(z.string().trim().min(1).max(40)),
  module: optionalFilter(z.string().trim().min(1).max(80)),
  action: optionalFilter(activityActionSchema),
  source: optionalFilter(activitySourceSchema),
  from: optionalFilter(isoDay),
  to: optionalFilter(isoDay),
});
export type ActivityEventsQuery = z.infer<typeof activityEventsQuerySchema>;

/** GET /activity/summaries?from&to&scope=team: daily summaries of the people below the caller. At most 31 days. */
export const summariesQuerySchema = z
  .object({ from: isoDay, to: isoDay, scope: optionalFilter(z.literal('team')) })
  .refine((q) => q.from <= q.to, { message: '"from" must not be after "to"', path: ['from'] });
export type SummariesQuery = z.infer<typeof summariesQuerySchema>;

/** GET /activity/timeline?empId&date */
export const timelineQuerySchema = z.object({ empId: empIdSchema, date: isoDay });
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

/** GET /activity/alerts?status (default: all). Every open alert, plus the newest ALERTS_CHECKED_LIMIT checked ones. */
export const alertsQuerySchema = z.object({ status: optionalFilter(z.enum(['open', 'checked', 'all'])) });
export type AlertsQuery = z.infer<typeof alertsQuerySchema>;

/** POST /activity/alerts/:id/check: the reviewer's note is kept with the alert. */
export const checkAlertRequestSchema = z.object({ note: z.string().trim().min(3, 'Write what you found (at least 3 characters)').max(500) }).strict();
export type CheckAlertRequest = z.infer<typeof checkAlertRequestSchema>;

/** POST /sessions/:id/force-logout and POST /employees/:empId/lock: the reason is saved and shown to the employee. */
export const controlReasonRequestSchema = z.object({ reason: z.string().trim().min(3, 'Please give a reason (at least 3 characters)').max(500) }).strict();
export type ControlReasonRequest = z.infer<typeof controlReasonRequestSchema>;

/** POST /employees/:empId/unlock */
export const unlockAccountRequestSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();
export type UnlockAccountRequest = z.infer<typeof unlockAccountRequestSchema>;

/**
 * POST /activity/export: the screens build Excel and PDF files themselves; the server records that the export happened
 * (and the large-export alert reads it). `module` is the screen's module (default Activity), `dataset` what was exported.
 * A flood is ignored: only the first few exports per session and per person in a minute are recorded (`recorded: false`).
 */
export const exportLogRequestSchema = z
  .object({
    rows: z.number().int().min(0).max(10_000_000),
    format: z.enum(['xlsx', 'pdf', 'csv']),
    module: z.string().trim().min(1).max(40).optional(),
    dataset: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type ExportLogRequest = z.infer<typeof exportLogRequestSchema>;

// ---------- responses (the shapes of frontend/src/features/activity/types.ts) ----------

export interface FieldDiffView {
  field: string;
  from: string;
  to: string;
}

export interface ActivityEventView {
  id: string;
  empId: string;
  at: string;
  source: ActivitySource;
  action: ActivityActionName;
  module: string;
  target?: string;
  description: string;
  /** Old and new values, joined from the audit log of the same request (never copied into the activity tables). */
  changes?: FieldDiffView[];
  ip?: string;
  city?: string;
  device?: string;
  /** For logout events. */
  how?: LogoutHow;
}

export interface OnlineSessionView {
  sessionId: string;
  empId: string;
  since: string;
  currentScreen: string;
  state: 'active' | 'idle';
  device: string;
  city: string;
  newDevice?: boolean;
}

export interface IdleSpanView {
  from: string;
  to: string;
}

export interface DailySummaryView {
  empId: string;
  /** The day in Pakistan time (YYYY-MM-DD). */
  date: string;
  firstLogin?: string;
  /** Missing while the person is still signed in. */
  lastLogout?: string;
  activeMinutes: number;
  idleMinutes: number;
  actions: number;
  /** 0 until Module 5 (tasks) is connected. */
  tasksTouched: number;
  /** Missing until Module 7 (attendance) is connected. */
  checkIn?: string;
  idleSpans?: IdleSpanView[];
}

export interface SecurityAlertView {
  id: string;
  rule: string;
  severity: AlertSeverityName;
  empId: string;
  at: string;
  details: string;
  status: 'open' | 'checked';
  checkedBy?: string;
  checkedAt?: string;
  note?: string;
  kind?: AlertKindName;
}

export interface AccountLockView {
  empId: string;
  at: string;
  /** The Emp-ID of whoever locked it, or "system" (5 wrong passwords). */
  by: string;
  reason: string;
}

export interface TimelineResponse {
  summary?: DailySummaryView;
  /** null when the caller may see the person's daily summary but not the full timeline. */
  events: ActivityEventView[] | null;
}

export interface MyActivityResponse {
  /** Today so far, worked out live from every session, heartbeat and action (missing before the first login today). */
  today?: DailySummaryView;
  /** My own records of the last 14 days, newest first (at most 200). */
  events: ActivityEventView[];
  /** Screens opened in this session, newest first (at most 40). */
  liveScreens: Array<{ at: string; screen: string }>;
  /** This session's "still here" signals today, newest first (at most 120). Already counted in `today`. */
  heartbeats: Array<{ at: string; active: boolean }>;
}

/** POST /activity/heartbeat, /activity/screen and /activity/export answer this. `recorded` is false when the signal was ignored (no session, or too many at once). */
export interface SignalResponse {
  ok: true;
  recorded: boolean;
}
