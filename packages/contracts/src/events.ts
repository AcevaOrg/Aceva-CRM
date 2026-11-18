import { z } from 'zod';

/**
 * Outbox event contracts.
 *
 * A module writes an event into the `outbox_events` table in the SAME database
 * transaction as the change it describes. The outbox dispatcher
 * (backend/src/events/outbox-dispatcher.service.ts) hands each event to every
 * consumer registered for its type and version; Module 4 consumes the auth.*
 * events. Events nobody consumes yet simply wait in the table.
 *
 * Rules:
 *  - Every event has a `type` and an integer `version`. A breaking change to a
 *    payload means a NEW version (v2); never edit v1.
 *  - Payloads contain Emp-IDs (e.g. ACV-0007), never internal UUIDs, and never
 *    secrets, passwords, tokens or pay figures.
 */

export const empIdSchema = z.string().regex(/^ACV-\d{4,}$/, 'Emp-ID looks like ACV-0001');

/** The common wrapper around every event. */
export const outboxEventBaseSchema = z.object({
  id: z.uuid(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  /** Who caused it: an Emp-ID, or "system" for scheduled jobs. */
  actor: z.union([empIdSchema, z.literal('system')]),
  payload: z.record(z.string(), z.unknown()),
});

export type OutboxEventEnvelope = z.infer<typeof outboxEventBaseSchema>;

function defineEvent<T extends string, V extends number, P extends z.ZodType>(
  type: T,
  version: V,
  payload: P,
) {
  return outboxEventBaseSchema.extend({
    type: z.literal(type),
    version: z.literal(version),
    payload,
  });
}

// ---------- Module 2 -> Module 4 (activity tracking) ----------

/** Written after every successful login. */
export const authLoginV1 = defineEvent(
  'auth.login',
  1,
  z.object({
    empId: empIdSchema,
    sessionId: z.uuid(),
    ip: z.string(),
    userAgent: z.string().nullable(),
  }),
);

/** Written after every failed login (wrong password, locked, rate limited...). */
export const authLoginFailedV1 = defineEvent(
  'auth.login_failed',
  1,
  z.object({
    /** What was typed in the Emp-ID box; may not belong to a real employee. */
    empIdAttempted: z.string(),
    /** Set only when the typed Emp-ID matched a real employee. */
    empId: empIdSchema.nullable(),
    reason: z.enum([
      'invalid_credentials',
      'locked',
      'rate_limited',
      'two_factor_failed',
      'disabled',
    ]),
    ip: z.string(),
    userAgent: z.string().nullable(),
  }),
);

/** Written whenever a session ends. */
export const authLogoutV1 = defineEvent(
  'auth.logout',
  1,
  z.object({
    empId: empIdSchema,
    sessionId: z.uuid(),
    reason: z.enum([
      'user',
      'idle_timeout',
      'max_duration',
      'password_changed',
      'forced',
      'employee_left',
      // Ended from another device in "My devices" (not a signal from that session), and 5 wrong codes in a row.
      'user_other_device',
      'too_many_wrong_codes',
    ]),
  }),
);

/**
 * Security events on an account that are not a login or a logout: password changed or reset, two-step login switched
 * on, off or reset, account locked or unlocked, temporary password set. `byEmpId` is the administrator who did it, or
 * null when the person did it themselves or the system did it (5 wrong passwords lock the account).
 */
export const AUTH_SECURITY_KINDS = [
  'password_changed',
  'password_reset',
  'two_factor_enabled',
  'two_factor_disabled',
  'two_factor_reset',
  'account_locked',
  'account_unlocked',
  'temporary_password_set',
] as const;

export const authSecurityV1 = defineEvent(
  'auth.security',
  1,
  z.object({
    empId: empIdSchema,
    kind: z.enum(AUTH_SECURITY_KINDS),
    byEmpId: empIdSchema.nullable(),
  }),
);

// ---------- Module 4 (activity tracking) ----------

/** The alert rules of plan section 8, and the severities. */
export const ALERT_KINDS = ['account_locked', 'new_device', 'outside_hours', 'large_export', 'salary_views', 'finance_attempts'] as const;
export const ALERT_SEVERITIES = ['low', 'medium', 'high'] as const;

/**
 * Module 4 internal: an activity event an alert rule must look at (a blocked finance attempt, a salary or bank detail
 * view, an export). Written in the same transaction as the activity event, so the rule runs even after a restart.
 */
export const activityFlaggedV1 = defineEvent(
  'activity.flagged',
  1,
  z.object({
    eventId: z.uuid(),
    empId: empIdSchema,
    kind: z.enum(['finance_blocked', 'salary_view', 'export']),
    /** When the activity happened. */
    at: z.iso.datetime(),
    module: z.string().min(1).max(80),
    /** Rows exported (exports only, otherwise null). */
    rows: z.number().int().min(0).nullable(),
  }),
);

/** A security alert was raised. Module 4 mails the Director and the CTO; Module 12 (notifications) can consume it too. */
export const activityAlertRaisedV1 = defineEvent(
  'activity.alert.raised',
  1,
  z.object({
    alertId: z.uuid(),
    kind: z.enum(ALERT_KINDS),
    severity: z.enum(ALERT_SEVERITIES),
    empId: empIdSchema,
  }),
);

// ---------- Module 3 -> Module 5 (tasks) and Module 8 (payroll) ----------

/** The employee's last working day was processed: login disabled, sessions ended. */
export const employeeOffboardedV1 = defineEvent(
  'employee.offboarded',
  1,
  z.object({
    empId: empIdSchema,
    lastWorkingDay: z.iso.date(),
    managerEmpId: empIdSchema.nullable(),
  }),
);

/** Ask Module 5 to move the leaving employee's open tasks to their manager. */
export const taskTransferRequestedV1 = defineEvent(
  'task.transfer.requested',
  1,
  z.object({
    fromEmpId: empIdSchema,
    toEmpId: empIdSchema,
    reason: z.literal('employee_left'),
  }),
);

/** Ask Module 8 to prepare the leaving employee's final salary. */
export const payrollFinalSettlementRequestedV1 = defineEvent(
  'payroll.final_settlement.requested',
  1,
  z.object({
    empId: empIdSchema,
    lastWorkingDay: z.iso.date(),
  }),
);

/** Every known event, by type and version. */
export const outboxEventSchemas = {
  'auth.login': { 1: authLoginV1 },
  'auth.login_failed': { 1: authLoginFailedV1 },
  'auth.logout': { 1: authLogoutV1 },
  'auth.security': { 1: authSecurityV1 },
  'activity.flagged': { 1: activityFlaggedV1 },
  'activity.alert.raised': { 1: activityAlertRaisedV1 },
  'employee.offboarded': { 1: employeeOffboardedV1 },
  'task.transfer.requested': { 1: taskTransferRequestedV1 },
  'payroll.final_settlement.requested': { 1: payrollFinalSettlementRequestedV1 },
} as const;

export type OutboxEventType = keyof typeof outboxEventSchemas;

export const outboxEventSchema = z.discriminatedUnion('type', [
  authLoginV1,
  authLoginFailedV1,
  authLogoutV1,
  authSecurityV1,
  activityFlaggedV1,
  activityAlertRaisedV1,
  employeeOffboardedV1,
  taskTransferRequestedV1,
  payrollFinalSettlementRequestedV1,
]);

export type OutboxEvent = z.infer<typeof outboxEventSchema>;
