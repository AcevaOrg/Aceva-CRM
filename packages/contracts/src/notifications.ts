import { z } from 'zod';
import { empIdSchema } from './events';

/**
 * Minimal Module 12 notification core (Cycle 3 shared foundation, plan section 17).
 * In the app (the bell) and by email. Each person can turn off non-essential emails; approvals and security alerts
 * cannot be turned off (also a database rule). The types match frontend/src/features/system/types.ts.
 */
export const notificationTypeSchema = z.enum([
  'task_assigned',
  'task_due_soon',
  'task_overdue',
  'task_reviewed',
  'extension_requested',
  'extension_answered',
  'leave_requested',
  'leave_answered',
  'correction_answered',
  'approval_waiting',
  'payroll_ready',
  'payslip_available',
  'scorecard_released',
  'security_alert',
  'sales_reply',
  'sales_follow_up',
  'sales_tool_problem',
  // M15.6: the nightly daily sales report is ready (to the sales managers); a manager asked for proof of a day's log
  'sales_daily_report',
  'sales_proof_requested',
  'message_mention',
  // Module 14 (later part): a new message in a DM or group (one per conversation until it is read), a reply to my message
  'message_new',
  'message_reply',
  // Module 14 meetings: invited to a meeting, a meeting I was invited to was cancelled
  'meeting_invited',
  'meeting_cancelled',
  'announcement',
  'renewal_due',
  'invoice_overdue',
  // Module 13
  'invoice_due',
  'invoice_draft_ready',
  'usage_alert',
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/** Approvals and security alerts: always shown, always emailed. Keep equal to the CHECK in the foundation migration. */
export const ESSENTIAL_NOTIFICATION_TYPES = ['approval_waiting', 'payroll_ready', 'leave_requested', 'extension_requested', 'security_alert'] as const satisfies readonly NotificationType[];

export const isEssentialNotificationType = (type: NotificationType): boolean => (ESSENTIAL_NOTIFICATION_TYPES as readonly NotificationType[]).includes(type);

/** GET /notifications (the caller's own only). */
export const notificationViewSchema = z.object({
  id: z.uuid(),
  empId: empIdSchema,
  type: notificationTypeSchema,
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  at: z.iso.datetime(),
  read: z.boolean(),
  essential: z.boolean(),
});
export type NotificationView = z.infer<typeof notificationViewSchema>;

export const notificationListQuerySchema = z.object({ unread: z.enum(['true', 'false']).optional() });

/** POST /notifications/read. No ids = mark all of the caller's notifications read. */
export const markNotificationsReadSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200).optional() }).strict();
export type MarkNotificationsRead = z.infer<typeof markNotificationsReadSchema>;

/** GET and PATCH /notifications/prefs. `email[type] = false` turns that email off (refused for essential types). */
export const notificationPrefsSchema = z
  .object({
    email: z.partialRecord(notificationTypeSchema, z.boolean()),
    dailySummary: z.boolean(),
  })
  .strict();
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

/** Module settings of the notification core (module "notifications", GET/PUT /settings/modules/notifications). */
export const notificationSettingsSchema = z
  .object({
    /** Company-wide switch for notification emails. Off = emails wait (nothing is dropped) until it is switched on. */
    emailEnabled: z.boolean(),
  })
  .strict();
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
