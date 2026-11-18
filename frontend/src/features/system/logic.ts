/**
 * Pure helpers for Module 12: audit hash chain, value diffs, settings catalogue, labels.
 */
import type { Permission } from "@/lib/auth/permissions";
import type { AuditAction, AuditChange, NotificationType, SettingsSectionKey, SettingsValues } from "./types";

/* ---------------- Hash chain (plan §16) ---------------- */

function fnv1a(input: string, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Demo fingerprint (the server uses SHA-256). Includes the previous row's hash. */
export function chainHash(prevHash: string, content: string) {
  const s = `${prevHash}|${content}`;
  return fnv1a(s) + fnv1a(s, 0x01000193);
}

export const GENESIS_HASH = "0000000000000000";

/* ---------------- Diffs ---------------- */

function show(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (Array.isArray(v)) return v.length > 3 ? `${v.length} items` : v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function diffValues(before: SettingsValues, after: SettingsValues): AuditChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: AuditChange[] = [];
  keys.forEach((k) => {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push({ field: k, from: show(before[k]), to: show(after[k]) });
  });
  return out;
}

/* ---------------- Settings catalogue (spec §9.12) ---------------- */

export interface SectionMeta {
  key: SettingsSectionKey;
  label: string;
  group: "Company" | "Work and performance" | "Finance" | "Security and records" | "Sales";
  description: string;
  /** ★ Director only, with step-up confirmation (the CEO / Founder / Owner views it). */
  protected?: boolean;
  /**
   * Extra permission (any of) needed to see the section on top of settings.view. Finance and sales rules
   * stay hidden from the CTO, who has no finance, payroll or sales access.
   */
  viewPermission?: Permission | Permission[];
}

export const SECTIONS: SectionMeta[] = [
  { key: "company", label: "Company details", group: "Company", description: "Legal name, tax numbers and the address printed on invoices, payslips and outreach emails." },
  { key: "schedule", label: "Working days and hours", group: "Company", description: "Start and end time, late grace period and office-only check-in." },
  { key: "holidays", label: "Holiday calendar", group: "Company", description: "Public and company holidays. Used by tasks, leave and payroll." },
  { key: "leave-types", label: "Leave types", group: "Company", description: "Leave types and their yearly balance." },
  { key: "task-sizes", label: "Task sizes and deadlines", group: "Work and performance", description: "Hours, points and suggested working days for each task size." },
  { key: "score-weights", label: "Score weights", group: "Work and performance", description: "How the monthly scorecard is weighted. Old scorecards keep the weights they were made with." },
  { key: "approval-limits", label: "Approval limits", group: "Finance", description: "A different person approves each journal entry at the level its amount needs: Director, then CEO, then the Owner (no limit, and every capital or loan entry).", protected: true, viewPermission: "finance.view" },
  { key: "currencies", label: "Currencies and exchange rates", group: "Finance", description: "PKR is the main currency. USD entries save the rate used.", viewPermission: "finance.view" },
  { key: "finance-year", label: "Finance year", group: "Finance", description: "When the finance year starts and ends.", viewPermission: "finance.view" },
  { key: "chart-of-accounts", label: "Chart of accounts", group: "Finance", description: "Accounts are managed in the ledger.", viewPermission: "finance.view" },
  { key: "tax-slabs", label: "Tax slabs", group: "Finance", description: "Yearly salary income tax slabs used by payroll.", viewPermission: ["payroll.view", "finance.view"] },
  { key: "security", label: "Password and session rules", group: "Security and records", description: "Password length, lockout, session timeouts and two-step login.", protected: true },
  { key: "alert-rules", label: "Alert rules", group: "Security and records", description: "When the system alerts the CEO / Founder / Owner, the Director and the CTO." },
  { key: "retention", label: "Data retention", group: "Security and records", description: "How long records are kept before they are archived or removed." },
  { key: "backups", label: "Backups", group: "Security and records", description: "Nightly encrypted backups and monthly restore tests." },
  { key: "sales", label: "Sales targets and rules", group: "Sales", description: "Default daily targets, deal stages, lost reasons and commission. Set by the Director (sales manager).", viewPermission: "sales.targets" },
  { key: "sales-tools", label: "Sales tools", group: "Sales", description: "Apollo, MillionVerifier and outreach mailboxes are connected in Integrations.", viewPermission: "integrations.view" },
];

export const sectionMeta = (k: string) => SECTIONS.find((s) => s.key === k) ?? SECTIONS[0];

/** Whether someone with these permissions may see a section (settings.view is checked separately). */
export function canViewSection(meta: SectionMeta, can: (p: Permission | Permission[]) => boolean) {
  return !meta.viewPermission || can(meta.viewPermission);
}

/* ---------------- Labels ---------------- */

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  create: "Created",
  edit: "Edited",
  delete: "Archived",
  approve: "Approved",
  reject: "Rejected",
  post: "Posted",
  reverse: "Reversed",
  export: "Exported",
  permission_change: "Permission change",
  lock: "Locked",
  unlock: "Unlocked",
  close: "Closed",
  reopen: "Reopened",
  reveal: "Sensitive view",
};

export const AUDIT_MODULES = [
  "Access", "People", "Tasks", "Performance", "Attendance", "Payroll", "Ledger", "Statements", "Billing", "Sales", "Integrations", "Settings",
];

export const NOTIFICATION_LABEL: Record<NotificationType, string> = {
  task_assigned: "Task assigned to me",
  task_due_soon: "Task due soon",
  task_overdue: "Task overdue",
  task_reviewed: "Task reviewed",
  extension_requested: "Extension asked",
  extension_answered: "Extension answered",
  leave_requested: "Leave asked",
  leave_answered: "Leave answered",
  approval_waiting: "Approval waiting",
  payroll_ready: "Payroll ready",
  payslip_available: "Payslip available",
  scorecard_released: "Scorecard released",
  security_alert: "Security alert",
  sales_reply: "New sales reply",
  sales_follow_up: "Sales follow-up due",
  sales_tool_problem: "Sales tool problem",
  message_mention: "Mention in messages",
  announcement: "Announcement",
  renewal_due: "Subscription renewal",
  invoice_overdue: "Invoice overdue",
};
