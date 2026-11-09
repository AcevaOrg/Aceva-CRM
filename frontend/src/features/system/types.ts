/**
 * Module 12 · Audit log, backup, notifications, settings (plan §17)
 * Owner: Developer C (cycle 4). Spec §9.12.
 * This file is the API contract for the module.
 */

export type NotificationType =
  | "task_assigned" | "task_due_soon" | "task_overdue" | "task_reviewed"
  | "extension_requested" | "extension_answered"
  | "leave_requested" | "leave_answered"
  | "approval_waiting" | "payroll_ready" | "payslip_available" | "scorecard_released"
  | "security_alert" | "sales_reply" | "sales_follow_up" | "sales_tool_problem"
  | "message_mention" | "announcement" | "renewal_due" | "invoice_overdue";

export interface Notification {
  id: string;
  empId: string;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  at: string;
  read: boolean;
  /** Approvals and security alerts cannot be turned off (plan §17). */
  essential: boolean;
}

export interface NotificationPrefs {
  email: Partial<Record<NotificationType, boolean>>;
  dailySummary: boolean;
}

export const NOTIFICATION_GROUP: Record<NotificationType, "approvals" | "mentions" | "other"> = {
  task_assigned: "other", task_due_soon: "other", task_overdue: "other", task_reviewed: "other",
  extension_requested: "approvals", extension_answered: "other",
  leave_requested: "approvals", leave_answered: "other",
  approval_waiting: "approvals", payroll_ready: "approvals", payslip_available: "other", scorecard_released: "other",
  security_alert: "other", sales_reply: "other", sales_follow_up: "other", sales_tool_problem: "other",
  message_mention: "mentions", announcement: "other", renewal_due: "other", invoice_overdue: "other",
};

export const ESSENTIAL_TYPES: NotificationType[] = ["approval_waiting", "payroll_ready", "leave_requested", "extension_requested", "security_alert"];

/* ---------------- Audit log (plan §17, §16 tamper-proof chain) ---------------- */

export type AuditAction =
  | "create" | "edit" | "delete" | "approve" | "reject" | "post" | "reverse" | "export"
  | "permission_change" | "lock" | "unlock" | "close" | "reopen" | "reveal";

export interface AuditChange {
  field: string;
  from: string;
  to: string;
}

export interface AuditRecord {
  id: string;
  /** Position in the chain, 1-based. */
  seq: number;
  at: string;
  empId: string;
  module: string;
  action: AuditAction;
  recordType: string;
  recordId: string;
  summary: string;
  changes?: AuditChange[];
  reason?: string;
  ip?: string;
  /** Fingerprint of this row including prevHash; a direct DB edit breaks the chain. */
  hash: string;
  prevHash: string;
}

export interface AuditFilters {
  empId?: string;
  module?: string;
  action?: AuditAction | "";
  from?: string;
  to?: string;
  q?: string;
}

export interface AuditIntegrity {
  ok: boolean;
  checkedAt: string;
  rows: number;
  /** seq of the first broken row, if any */
  brokenAt?: number;
}

/* ---------------- Backups ---------------- */

export interface BackupRun {
  id: string;
  at: string;
  kind: "daily" | "monthly";
  sizeMb: number;
  ok: boolean;
  durationMin: number;
}

export interface RestoreTest {
  at: string;
  ok: boolean;
  by: string;
  durationMin: number;
  note: string;
}

export interface BackupStatus {
  lastBackupAt: string;
  ok: boolean;
  nextBackupAt: string;
  location: string;
  encrypted: boolean;
  dailyCopies: number;
  dailyKept: number;
  monthlyCopies: number;
  monthlyKept: number;
  recent: BackupRun[];
  lastRestoreTest: RestoreTest;
  restoreTests: RestoreTest[];
}

/* ---------------- Settings ---------------- */

export type SettingsSectionKey =
  | "company" | "schedule" | "holidays" | "leave-types" | "task-sizes" | "score-weights"
  | "approval-limits" | "currencies" | "finance-year" | "chart-of-accounts" | "tax-slabs"
  | "security" | "alert-rules" | "sales" | "sales-tools" | "retention" | "backups";

export type SettingsValues = Record<string, unknown>;

export interface SettingsRecord {
  section: SettingsSectionKey;
  values: SettingsValues;
  updatedAt: string;
  updatedBy: string;
}

export interface WeightsVersion {
  id: string;
  /** standard: Software Development, and Management · sales: the Sales department. */
  kind: "standard" | "sales";
  weights: Record<string, number>;
  effectiveFrom: string;
  createdBy: string;
  note?: string;
}
