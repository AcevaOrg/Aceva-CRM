import { z } from 'zod';

/**
 * Outbox event contracts.
 *
 * A module writes an event into the `outbox_events` table in the SAME database
 * transaction as the change it describes. A later module (a "consumer") reads
 * the events it cares about. Consumers are NOT part of Cycle 1.
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
    ]),
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

// ---------- Modules 7, 8, 9 -> Module 12 (notifications), Module 4 and Module 6 (defined now, produced now) ----------
// No pay figures, salary amounts or bank details in any of these payloads.

const dayString = z.iso.date();
const monthString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** M7: a leave request was made and waits for its first approver. */
export const leaveRequestedV1 = defineEvent(
  'leave.requested',
  1,
  z.object({ requestNumber: z.string(), empId: empIdSchema, approverEmpId: empIdSchema.nullable(), from: dayString, to: dayString }),
);

/** M7: an approval step on a leave request was decided, or the request was cancelled. */
export const leaveDecidedV1 = defineEvent(
  'leave.decided',
  1,
  z.object({
    requestNumber: z.string(),
    empId: empIdSchema,
    decision: z.enum(['approved', 'rejected', 'cancelled', 'forwarded']),
    byEmpId: empIdSchema,
    nextApproverEmpId: empIdSchema.nullable(),
  }),
);

/** M7: an attendance correction was approved or rejected. */
export const attendanceCorrectionDecidedV1 = defineEvent(
  'attendance.correction.decided',
  1,
  z.object({ correctionId: z.uuid(), empId: empIdSchema, date: dayString, decision: z.enum(['approved', 'rejected']), byEmpId: empIdSchema }),
);

/** M8: a payroll run moved to the next person (prepared -> review, reviewed -> approval). Plan event "payroll ready". */
export const payrollRunReadyV1 = defineEvent(
  'payroll.run.ready',
  1,
  z.object({ runNumber: z.string(), month: monthString, stage: z.enum(['prepared', 'reviewed']) }),
);

/** M8: a payroll run was approved (its salary entry now waits in the ledger). */
export const payrollRunApprovedV1 = defineEvent(
  'payroll.run.approved',
  1,
  z.object({ runNumber: z.string(), month: monthString, approvedByEmpId: empIdSchema }),
);

/** M8: a payslip is available to its employee. Plan event "payslip available". */
export const payslipIssuedV1 = defineEvent('payslip.issued', 1, z.object({ empId: empIdSchema, month: monthString }));

/** M9: a journal entry was posted to the ledger. */
export const ledgerEntryPostedV1 = defineEvent(
  'ledger.entry.posted',
  1,
  z.object({ entryNumber: z.string(), source: z.string(), entryDate: dayString }),
);

/** M9: a closed month was reopened (plan: logged and alerted). */
export const financePeriodReopenedV1 = defineEvent(
  'finance.period.reopened',
  1,
  z.object({ month: monthString, byEmpId: empIdSchema, reason: z.string() }),
);

/** Every known event, by type and version. */
export const outboxEventSchemas = {
  'auth.login': { 1: authLoginV1 },
  'auth.login_failed': { 1: authLoginFailedV1 },
  'auth.logout': { 1: authLogoutV1 },
  'employee.offboarded': { 1: employeeOffboardedV1 },
  'task.transfer.requested': { 1: taskTransferRequestedV1 },
  'payroll.final_settlement.requested': { 1: payrollFinalSettlementRequestedV1 },
  'leave.requested': { 1: leaveRequestedV1 },
  'leave.decided': { 1: leaveDecidedV1 },
  'attendance.correction.decided': { 1: attendanceCorrectionDecidedV1 },
  'payroll.run.ready': { 1: payrollRunReadyV1 },
  'payroll.run.approved': { 1: payrollRunApprovedV1 },
  'payslip.issued': { 1: payslipIssuedV1 },
  'ledger.entry.posted': { 1: ledgerEntryPostedV1 },
  'finance.period.reopened': { 1: financePeriodReopenedV1 },
} as const;

export type OutboxEventType = keyof typeof outboxEventSchemas;

export const outboxEventSchema = z.discriminatedUnion('type', [
  authLoginV1,
  authLoginFailedV1,
  authLogoutV1,
  employeeOffboardedV1,
  taskTransferRequestedV1,
  payrollFinalSettlementRequestedV1,
  leaveRequestedV1,
  leaveDecidedV1,
  attendanceCorrectionDecidedV1,
  payrollRunReadyV1,
  payrollRunApprovedV1,
  payslipIssuedV1,
  ledgerEntryPostedV1,
  financePeriodReopenedV1,
]);

export type OutboxEvent = z.infer<typeof outboxEventSchema>;
