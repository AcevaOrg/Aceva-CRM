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

// ---------- Module 5 (task management) ----------

/** The task sizes and statuses (plan section 9). The task contracts (tasks.ts) build their schemas from these lists. */
export const TASK_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
export const TASK_STATUSES = ['assigned', 'in_progress', 'submitted', 'under_review', 'approved', 'rework', 'on_hold', 'cancelled'] as const;

const taskSizeEnum = z.enum(TASK_SIZES);
const taskStatusEnum = z.enum(TASK_STATUSES);
/** What every task event says about the task. */
const taskRef = { taskId: z.uuid(), number: z.string().min(1) };

/**
 * A task was created (by a manager, by a person for themselves, or by a repeating series). Module 5 automation reads it
 * to set the reminders, start a repeating series and mail the assignee; Module 6 counts assigned work from it.
 * actor = the person who created it, or "system" for a repeating series.
 */
export const taskCreatedV1 = defineEvent(
  'task.created',
  1,
  z.object({
    ...taskRef,
    assignee: empIdSchema,
    assignedBy: empIdSchema,
    personal: z.boolean(),
    size: taskSizeEnum,
    points: z.number().int().min(0),
    estimatedHours: z.number().positive(),
    startDate: z.iso.datetime(),
    deadline: z.iso.datetime(),
    /** Set when the task starts or belongs to a repeating series. */
    repeatRuleId: z.uuid().nullable(),
  }),
);

/** Any change of a task's status (including a hand-over that cancels it). actor = who did it. */
export const taskStatusChangedV1 = defineEvent(
  'task.status_changed',
  1,
  z.object({
    ...taskRef,
    assignee: empIdSchema,
    assignedBy: empIdSchema,
    personal: z.boolean(),
    from: taskStatusEnum,
    to: taskStatusEnum,
    reason: z.string().nullable(),
  }),
);

/** A reviewer approved a task with a rating. The figures Module 6 needs for the scorecard. actor = the reviewer. */
export const taskApprovedV1 = defineEvent(
  'task.approved',
  1,
  z.object({
    ...taskRef,
    assignee: empIdSchema,
    reviewer: empIdSchema,
    rating: z.number().int().min(1).max(5),
    size: taskSizeEnum,
    points: z.number().int().min(0),
    estimatedHours: z.number().positive(),
    /** The deadline in force when it was handed in (the approved deadline: on-time is measured against it). */
    deadline: z.iso.datetime(),
    originalDeadline: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    submittedAt: z.iso.datetime().nullable(),
    /** Handed in at or before the approved deadline. */
    onTime: z.boolean(),
    extensionsCount: z.number().int().min(0),
    reworkCount: z.number().int().min(0),
  }),
);

/** A reviewer sent a task back with a reason. actor = the reviewer. */
export const taskReworkedV1 = defineEvent(
  'task.reworked',
  1,
  z.object({
    ...taskRef,
    assignee: empIdSchema,
    reviewer: empIdSchema,
    reason: z.string().min(1),
    /** How many times it has been sent back, this one included. */
    reworkCount: z.number().int().min(1),
  }),
);

/** The deadline moved: the manager changed it (with a reason) or an extension was approved. */
export const taskDeadlineChangedV1 = defineEvent(
  'task.deadline_changed',
  1,
  z.object({
    ...taskRef,
    assignee: empIdSchema,
    assignedBy: empIdSchema,
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    kind: z.enum(['manager_change', 'extension_approved']),
    reason: z.string().nullable(),
  }),
);

/** The person asked for more time. `late` = asked after the deadline. actor = the person asking. */
export const taskExtensionRequestedV1 = defineEvent(
  'task.extension_requested',
  1,
  z.object({
    ...taskRef,
    extensionId: z.uuid(),
    assignee: empIdSchema,
    assignedBy: empIdSchema,
    currentDeadline: z.iso.datetime(),
    requestedDeadline: z.iso.datetime(),
    late: z.boolean(),
  }),
);

/** The assigner decided an extension request. newDeadline is set only when it was approved. actor = the decider. */
export const taskExtensionDecidedV1 = defineEvent(
  'task.extension_decided',
  1,
  z.object({
    ...taskRef,
    extensionId: z.uuid(),
    requestedBy: empIdSchema,
    decidedBy: empIdSchema,
    decision: z.enum(['approved', 'rejected']),
    newDeadline: z.iso.datetime().nullable(),
    late: z.boolean(),
  }),
);

/** A comment was added. `mentions` are the Emp-IDs it @mentioned (the mention mail goes to them). actor = the author. */
export const taskCommentAddedV1 = defineEvent(
  'task.comment_added',
  1,
  z.object({
    ...taskRef,
    commentId: z.uuid(),
    assignee: empIdSchema,
    assignedBy: empIdSchema,
    mentions: z.array(empIdSchema),
  }),
);

/** A task moved to someone else because its owner left (Module 3 asked with task.transfer.requested). actor = "system". */
export const taskTransferredV1 = defineEvent(
  'task.transferred',
  1,
  z.object({
    ...taskRef,
    fromEmpId: empIdSchema,
    toEmpId: empIdSchema,
    reason: z.literal('employee_left'),
  }),
);

/** A reminder is due: half the time passed without a start, 24 hours before, at the deadline, or a daily overdue notice. actor = "system". */
export const TASK_REMINDER_KINDS = ['half_time', 'day_before', 'deadline', 'overdue'] as const;
export const taskReminderDueV1 = defineEvent(
  'task.reminder.due',
  1,
  z.object({
    ...taskRef,
    kind: z.enum(TASK_REMINDER_KINDS),
    /** The person doing it, and for an overdue notice also their manager. */
    recipients: z.array(empIdSchema).min(1),
    deadline: z.iso.datetime(),
    /** The Pakistan day the notice is for (makes a daily overdue notice unique per day). */
    day: z.iso.date(),
  }),
);

// ---------- Module 6: performance and results ----------

export const SCORECARD_KINDS = ['standard', 'sales'] as const;
/** A month as "2026-10" (a Pakistan month). */
export const scorecardMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month looks like 2026-10');

const scorecardRef = {
  scorecardId: z.uuid(),
  /** The person the scorecard is about. */
  empId: empIdSchema,
  month: scorecardMonthSchema,
  kind: z.enum(SCORECARD_KINDS),
};

/**
 * The monthly job made a draft scorecard (actor "system"). `reviewer` is who must review and release it; null for the
 * Director, whose scorecard has no reviewer and is released at once (a scorecard.released event follows). `score` is
 * null when nothing could be measured (for example a sales scorecard before Module 15 exists).
 */
export const scorecardDraftedV1 = defineEvent(
  'scorecard.drafted',
  1,
  z.object({
    ...scorecardRef,
    reviewer: empIdSchema.nullable(),
    score: z.number().min(0).max(100).nullable(),
    taskCount: z.number().int().min(0),
    smallSample: z.boolean(),
  }),
);

/** A scorecard was released to the employee: by the reviewer (actor), or by the system when there is no reviewer. */
export const scorecardReleasedV1 = defineEvent(
  'scorecard.released',
  1,
  z.object({
    ...scorecardRef,
    /** Null = released by the system (no reviewer). */
    releasedBy: empIdSchema.nullable(),
    automatic: z.boolean(),
    hasRemark: z.boolean(),
  }),
);

/** The employee acknowledged a released scorecard (actor = the employee). */
export const scorecardAcknowledgedV1 = defineEvent(
  'scorecard.acknowledged',
  1,
  z.object({
    ...scorecardRef,
    reviewer: empIdSchema.nullable(),
    hasComment: z.boolean(),
  }),
);

/** The employee disputed a task rating on their scorecard (actor = the employee). `decider` must decide it. */
export const scorecardDisputeRaisedV1 = defineEvent(
  'scorecard.dispute_raised',
  1,
  z.object({
    disputeId: z.uuid(),
    scorecardId: z.uuid(),
    empId: empIdSchema,
    month: scorecardMonthSchema,
    taskId: z.uuid(),
    taskNumber: z.string().min(1),
    ratingAtRaise: z.number().int().min(1).max(5),
    decider: empIdSchema,
  }),
);

/**
 * A dispute was decided (actor = the decider): the rating was kept (upheld) or changed. When changed, the scorecard was
 * recomputed with its original weights version: scoreBefore / scoreAfter are its score before and after (null = none).
 */
export const scorecardDisputeDecidedV1 = defineEvent(
  'scorecard.dispute_decided',
  1,
  z.object({
    disputeId: z.uuid(),
    scorecardId: z.uuid(),
    empId: empIdSchema,
    month: scorecardMonthSchema,
    taskNumber: z.string().min(1),
    decision: z.enum(['upheld', 'changed']),
    decidedBy: empIdSchema,
    ratingBefore: z.number().int().min(1).max(5),
    ratingAfter: z.number().int().min(1).max(5).nullable(),
    scoreBefore: z.number().min(0).max(100).nullable(),
    scoreAfter: z.number().min(0).max(100).nullable(),
  }),
);

/** The Director saved a new version of the score weights (actor = the Director). Old scorecards keep their version. */
export const scoreWeightsCreatedV1 = defineEvent(
  'score_weights.created',
  1,
  z.object({
    versionId: z.uuid(),
    kind: z.enum(SCORECARD_KINDS),
    /** Null = the company-wide set; set = that department's own set. */
    departmentId: z.uuid().nullable(),
    versionNo: z.number().int().min(1),
    /** Whole percentages by metric key; they add up to 100. */
    weights: z.record(z.string(), z.number().int().min(0).max(100)),
    previousVersionId: z.uuid().nullable(),
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

// ---------- Cycle 3: Modules 13, 14, 15 (defined in the shared foundation; each is produced once its module is built) ----------
// Same rules as above: Emp-IDs and document numbers only, no amounts, no prospect or customer personal data.

/**
 * M15: a Won deal was confirmed (by the sales manager, or the Director until there is one). M13 makes exactly one draft
 * invoice from it (unique per deal number) for the finance duty person to check and issue. Refined with M13 (nothing
 * produces it yet): the client, the service and the deal value travel with the event, so billing needs nothing from M15.
 */
export const salesDealWonConfirmedV1 = defineEvent(
  'sales.deal.won_confirmed',
  1,
  z.object({
    dealNumber: z.string().min(1),
    ownerEmpId: empIdSchema,
    confirmedByEmpId: empIdSchema,
    /** The Module 9 client when the company is already one; otherwise billing creates the client from the name. */
    client: z.object({
      partyId: z.uuid().nullable(),
      name: z.string().trim().min(1).max(200),
      email: z.email().nullable(),
      country: z.string().max(80).nullable(),
    }),
    service: z.string().trim().min(1).max(300),
    value: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/),
    currency: z.enum(['PKR', 'USD']),
  }),
);

/** M13: an invoice was issued; its ledger entry now waits for approval in Module 9. */
export const billingInvoiceIssuedV1 = defineEvent(
  'billing.invoice.issued',
  1,
  z.object({ invoiceNumber: z.string().min(1), dueDate: dayString, sourceDealNumber: z.string().min(1).nullable() }),
);

/** M13: an invoice is fully paid (its payments are posted in Module 9). M15 calculates commission from it. */
export const billingInvoicePaidV1 = defineEvent(
  'billing.invoice.paid',
  1,
  z.object({ invoiceNumber: z.string().min(1), paidOn: dayString, sourceDealNumber: z.string().min(1).nullable(), firstForClient: z.boolean() }),
);

/** M13: an invoice passed its due date unpaid. */
export const billingInvoiceOverdueV1 = defineEvent(
  'billing.invoice.overdue',
  1,
  z.object({ invoiceNumber: z.string().min(1), dueDate: dayString, daysOverdue: z.number().int().min(1) }),
);

/** M13: a subscription or domain renews soon; its responsible person is alerted. */
export const billingSubscriptionRenewalDueV1 = defineEvent(
  'billing.subscription.renewal_due',
  1,
  z.object({ subscriptionNumber: z.string().min(1), renewsOn: dayString, ownerEmpId: empIdSchema }),
);

/** M15: the Director approved a commission line; Module 8 adds it to that month's payroll as a bonus line. */
export const salesCommissionApprovedV1 = defineEvent(
  'sales.commission.approved',
  1,
  z.object({ dealNumber: z.string().min(1), empId: empIdSchema, approvedByEmpId: empIdSchema, payrollMonth: monthString }),
);

/** M14: someone was mentioned in a message (never the message text). */
export const commsMentionV1 = defineEvent(
  'comms.mention',
  1,
  z.object({ conversationId: z.uuid(), messageId: z.uuid(), mentionedEmpId: empIdSchema, byEmpId: empIdSchema }),
);

/** M14: an announcement was published to its audience. */
export const commsAnnouncementPublishedV1 = defineEvent(
  'comms.announcement.published',
  1,
  z.object({ announcementId: z.uuid(), byEmpId: empIdSchema, requiresAck: z.boolean() }),
);

/**
 * M14: a message was saved (never its text). Module 14's later parts deliver it live and notify people; nothing
 * consumes it yet.
 */
export const commsMessageCreatedV1 = defineEvent(
  'comms.message.created',
  1,
  z.object({
    conversationId: z.uuid(),
    conversationKind: z.enum(['dm', 'group', 'channel']),
    messageId: z.uuid(),
    seq: z.number().int().min(1),
    authorEmpId: empIdSchema,
    /** A reply: the message it answers. */
    parentMessageId: z.uuid().nullable(),
    mentionedEmpIds: z.array(empIdSchema),
  }),
);

/**
 * M14.2: a saved message changed (never its text): edited, deleted by its author, removed by a moderator, a reaction
 * added or taken back, pinned or unpinned. Read by the live-delivery safety net (`comms-realtime`), which re-sends the
 * live update when the first one was lost, so open screens always end up showing what the database holds.
 */
export const commsMessageChangedV1 = defineEvent(
  'comms.message.changed',
  1,
  z.object({
    conversationId: z.uuid(),
    messageId: z.uuid(),
    change: z.enum(['edited', 'deleted', 'removed', 'reaction', 'pinned', 'unpinned']),
  }),
);

/** M14: someone stopped being a member of a conversation (removed by a moderator or admin, left, or left the company). */
export const commsMemberRemovedV1 = defineEvent(
  'comms.member.removed',
  1,
  z.object({
    conversationId: z.uuid(),
    empId: empIdSchema,
    byEmpId: z.union([empIdSchema, z.literal('system')]),
    reason: z.enum(['removed', 'left', 'employee_left']),
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
  'task.created': { 1: taskCreatedV1 },
  'task.status_changed': { 1: taskStatusChangedV1 },
  'task.approved': { 1: taskApprovedV1 },
  'task.reworked': { 1: taskReworkedV1 },
  'task.deadline_changed': { 1: taskDeadlineChangedV1 },
  'task.extension_requested': { 1: taskExtensionRequestedV1 },
  'task.extension_decided': { 1: taskExtensionDecidedV1 },
  'task.comment_added': { 1: taskCommentAddedV1 },
  'task.transferred': { 1: taskTransferredV1 },
  'task.reminder.due': { 1: taskReminderDueV1 },
  'scorecard.drafted': { 1: scorecardDraftedV1 },
  'scorecard.released': { 1: scorecardReleasedV1 },
  'scorecard.acknowledged': { 1: scorecardAcknowledgedV1 },
  'scorecard.dispute_raised': { 1: scorecardDisputeRaisedV1 },
  'scorecard.dispute_decided': { 1: scorecardDisputeDecidedV1 },
  'score_weights.created': { 1: scoreWeightsCreatedV1 },
  'leave.requested': { 1: leaveRequestedV1 },
  'leave.decided': { 1: leaveDecidedV1 },
  'attendance.correction.decided': { 1: attendanceCorrectionDecidedV1 },
  'payroll.run.ready': { 1: payrollRunReadyV1 },
  'payroll.run.approved': { 1: payrollRunApprovedV1 },
  'payslip.issued': { 1: payslipIssuedV1 },
  'ledger.entry.posted': { 1: ledgerEntryPostedV1 },
  'finance.period.reopened': { 1: financePeriodReopenedV1 },
  'sales.deal.won_confirmed': { 1: salesDealWonConfirmedV1 },
  'billing.invoice.issued': { 1: billingInvoiceIssuedV1 },
  'billing.invoice.paid': { 1: billingInvoicePaidV1 },
  'billing.invoice.overdue': { 1: billingInvoiceOverdueV1 },
  'billing.subscription.renewal_due': { 1: billingSubscriptionRenewalDueV1 },
  'sales.commission.approved': { 1: salesCommissionApprovedV1 },
  'comms.mention': { 1: commsMentionV1 },
  'comms.announcement.published': { 1: commsAnnouncementPublishedV1 },
  'comms.message.created': { 1: commsMessageCreatedV1 },
  'comms.message.changed': { 1: commsMessageChangedV1 },
  'comms.member.removed': { 1: commsMemberRemovedV1 },
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
  taskCreatedV1,
  taskStatusChangedV1,
  taskApprovedV1,
  taskReworkedV1,
  taskDeadlineChangedV1,
  taskExtensionRequestedV1,
  taskExtensionDecidedV1,
  taskCommentAddedV1,
  taskTransferredV1,
  taskReminderDueV1,
  scorecardDraftedV1,
  scorecardReleasedV1,
  scorecardAcknowledgedV1,
  scorecardDisputeRaisedV1,
  scorecardDisputeDecidedV1,
  scoreWeightsCreatedV1,
  leaveRequestedV1,
  leaveDecidedV1,
  attendanceCorrectionDecidedV1,
  payrollRunReadyV1,
  payrollRunApprovedV1,
  payslipIssuedV1,
  ledgerEntryPostedV1,
  financePeriodReopenedV1,
  salesDealWonConfirmedV1,
  billingInvoiceIssuedV1,
  billingInvoicePaidV1,
  billingInvoiceOverdueV1,
  billingSubscriptionRenewalDueV1,
  salesCommissionApprovedV1,
  commsMentionV1,
  commsAnnouncementPublishedV1,
  commsMessageCreatedV1,
  commsMessageChangedV1,
  commsMemberRemovedV1,
]);

export type OutboxEvent = z.infer<typeof outboxEventSchema>;
