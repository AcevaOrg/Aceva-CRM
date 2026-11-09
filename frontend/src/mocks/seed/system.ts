/** Seed: audit trail, settings, score-weight versions, backups (Module 12). */
import { SIZE_RULES } from "@/features/tasks/logic";
import { DEFAULT_TAX_SLABS } from "@/features/payroll/logic";
import { chainHash, GENESIS_HASH } from "@/features/system/logic";
import type { AuditAction, AuditChange, AuditRecord, BackupStatus, SettingsRecord, SettingsSectionKey, SettingsValues, WeightsVersion } from "@/features/system/types";
import { HOLIDAYS } from "./calendar";
import { daysFromNow, minutesAgo } from "../time";

type Row = [minAgo: number, empId: string, module: string, action: AuditAction, recordType: string, recordId: string, summary: string, changes?: AuditChange[], reason?: string];

const H = 60;
const D = 60 * 24;

/*
 * Actors follow the structure: ACV-0001 CEO / Founder / Owner (views and exports, approves nothing),
 * ACV-0003 Director (approves everything; settings incl. ★, reporting lines; HR and sales-manager duty),
 * ACV-0004 CTO (engineering, security, backups, integrations), ACV-0010 Finance (prepares entries, payroll,
 * invoices, the month close; approves nothing).
 */
const ROWS: Row[] = [
  [12, "ACV-0004", "Tasks", "approve", "task", "TSK-0123", "Approved “Org chart tree component” with a 5-star rating"],
  [48, "ACV-0011", "Tasks", "create", "extension", "TSK-0131", "Asked for 2 more days on “Payslip PDF layout”"],
  [2 * H, "ACV-0003", "People", "edit", "person", "ACV-0011", "Changed pay: internet allowance", [{ field: "Internet allowance", from: "PKR 3,000", to: "PKR 5,000" }], "Annual review"],
  [3 * H + 20, "ACV-0010", "Payroll", "reveal", "bank_account", "ACV-0007", "Viewed bank account number of ACV-0007 while checking November payroll"],
  [4 * H, "ACV-0001", "Payroll", "reveal", "payroll_run", "PR-2026-11", "Opened the November payroll run (view only)"],
  [5 * H, "ACV-0010", "Ledger", "create", "journal_entry", "JE-2026-0311", "Created entry “Annual hosting prepayment” PKR 120,000 and sent it to the Director"],
  [6 * H, "ACV-0003", "Ledger", "approve", "journal_entry", "JE-2026-0309", "Approved entry “Office rent November” PKR 85,000 made by ACV-0010"],
  [7 * H, "ACV-0003", "Access", "permission_change", "role", "CTO", "Added task.review to the CTO role", [{ field: "task.review", from: "Off", to: "On" }], "The CTO reviews engineering tasks"],
  [20 * H, "ACV-0004", "Access", "unlock", "account", "ACV-0008", "Unlocked account after 5 wrong passwords"],
  [26 * H, "ACV-0010", "Payroll", "create", "payroll_run", "PR-2026-11", "Prepared November payroll (12 people) and sent it to the Director"],
  [28 * H, "ACV-0010", "Payroll", "lock", "attendance", "2026-11", "Locked November attendance for payroll"],
  [29 * H, "ACV-0004", "Attendance", "approve", "leave_request", "LV-0412", "Approved annual leave for ACV-0006 (2 days) and sent it to the Director"],
  [30 * H, "ACV-0003", "Sales", "approve", "deal", "DL-0017", "Confirmed won deal: Northwind Studio website"],
  [31 * H, "ACV-0003", "Sales", "approve", "commission", "CM-0004", "Approved commission PKR 9,000 for ACV-0012"],
  [33 * H, "ACV-0010", "Billing", "create", "invoice", "INV-2026-0047", "Created invoice USD 2,400 for Harbor & Co"],
  [2 * D, "ACV-0003", "Statements", "export", "statement", "Income statement · Oct 2026", "Exported the income statement (PDF, watermarked)"],
  [2 * D + 2 * H, "ACV-0001", "Statements", "export", "statement", "Balance sheet · Oct 2026", "Exported the balance sheet (PDF, watermarked)"],
  [2 * D + 3 * H, "ACV-0004", "Tasks", "edit", "task", "TSK-0125", "Changed deadline", [{ field: "Deadline", from: "12 Nov 2026", to: "14 Nov 2026" }], "Extension approved"],
  [3 * D, "ACV-0003", "Ledger", "approve", "period", "2026-10", "Approved the October 2026 month close"],
  [3 * D + H, "ACV-0010", "Ledger", "close", "period", "2026-10", "Ran the October 2026 month close and sent it to the Director"],
  [3 * D + 2 * H, "ACV-0010", "Ledger", "post", "journal_entry", "JE-2026-0301", "Posted October revaluation: USD gain PKR 14,220 (approved by the Director)"],
  [4 * D, "ACV-0003", "Settings", "edit", "settings", "approval-limits", "Changed approval limits", [{ field: "CEO / Founder / Owner notified above", from: "PKR 1,000,000", to: "PKR 500,000" }], "The Director approves every entry; the CEO / Founder / Owner sees the large ones"],
  [5 * D, "ACV-0004", "Integrations", "edit", "connection", "apollo", "Changed the Apollo API key", [{ field: "API key", from: "••••a91c", to: "••••4f2e" }], "Quarterly key rotation"],
  [6 * D, "ACV-0003", "People", "edit", "person", "ACV-0009", "Updated emergency contact", [{ field: "Emergency phone", from: "+92 300 2003571", to: "+92 301 7741200" }]],
  [7 * D, "ACV-0004", "Performance", "approve", "scorecard", "SC-2026-10-ACV-0007", "Released the October scorecard for ACV-0007"],
  [8 * D, "ACV-0010", "Ledger", "reverse", "journal_entry", "JE-2026-0298", "Reversed JE-2026-0298 (posted to the wrong expense account); reversal approved by the Director"],
  [9 * D, "ACV-0003", "Payroll", "export", "bank_sheet", "PR-2026-10", "Exported the October bank transfer sheet (Excel)"],
  [9 * D + H, "ACV-0003", "Payroll", "approve", "payroll_run", "PR-2026-10", "Approved October payroll prepared by ACV-0010"],
  [9 * D + 3 * H, "ACV-0010", "Payroll", "create", "payroll_run", "PR-2026-10", "Prepared October payroll (12 people) and sent it to the Director"],
  [10 * D, "ACV-0003", "Settings", "edit", "settings", "score-weights", "Saved new standard score weights", [{ field: "Quality", from: "40%", to: "35%" }, { field: "On-time", from: "20%", to: "25%" }], "Deadlines matter more after go-live"],
  [12 * D, "ACV-0003", "Access", "edit", "reporting_line", "ACV-0013", "Moved ACV-0013 under ACV-0004", [{ field: "Reports to", from: "ACV-0003", to: "ACV-0004" }], "Joined the engineering team"],
  [18 * D, "ACV-0003", "People", "create", "person", "ACV-0013", "Onboarded Nida Aslam (intern)"],
  [20 * D, "ACV-0004", "Access", "lock", "account", "ACV-0012", "Locked account after repeated finance access attempts"],
  [21 * D, "ACV-0003", "Access", "unlock", "account", "ACV-0012", "Unlocked account after review"],
  [25 * D, "ACV-0003", "Settings", "edit", "settings", "security", "Changed session rules", [{ field: "Finance idle timeout", from: "15 min", to: "10 min" }], "Plan §6"],
  [30 * D, "ACV-0003", "Ledger", "approve", "period", "2026-09", "Approved the September 2026 month close"],
  [30 * D + 2 * H, "ACV-0010", "Ledger", "close", "period", "2026-09", "Ran the September 2026 month close and sent it to the Director"],
];

let built: AuditRecord[] | null = null;

export function seedAudit(): AuditRecord[] {
  if (built) return structuredClone(built);
  const ordered = [...ROWS].sort((a, b) => b[0] - a[0]);
  let prev = GENESIS_HASH;
  const out: AuditRecord[] = ordered.map(([min, empId, module, action, recordType, recordId, summary, changes, reason], i) => {
    const at = minutesAgo(min);
    const hash = chainHash(prev, `${i + 1}|${at}|${empId}|${module}|${action}|${recordId}|${JSON.stringify(changes ?? [])}`);
    const rec: AuditRecord = { id: `aud_${i + 1}`, seq: i + 1, at, empId, module, action, recordType, recordId, summary, changes, reason, ip: `39.45.12.${20 + (i % 30)}`, hash, prevHash: prev };
    prev = hash;
    return rec;
  });
  built = out;
  return structuredClone(out);
}

const SETTINGS: Record<SettingsSectionKey, SettingsValues> = {
  company: {
    legalName: "Aceva (Private) Limited",
    tradingName: "Aceva",
    ntn: "8834521-6",
    secpNumber: "0187342",
    address: "House 12, Block B, Dadu, Sindh, Pakistan",
    phone: "+92 25 4711 200",
    website: "acevatech.com",
    emailDomain: "acevatech.com",
    outreachPostalAddress: "Aceva (Private) Limited, House 12, Block B, Dadu, Sindh 76200, Pakistan",
  },
  schedule: {
    workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    startTime: "09:00",
    endTime: "18:00",
    graceMinutes: 15,
    weeklyCapacity: 40,
    internCapacity: 20,
    autoCloseMissedCheckout: true,
    officeOnlyCheckIn: false,
    officeNetworks: ["Dadu HQ · 39.45.12.0/24", "Karachi Studio · 110.93.4.0/24"],
  },
  holidays: { holidays: HOLIDAYS },
  "leave-types": {
    types: [
      { name: "Casual", days: 10, paid: true },
      { name: "Sick", days: 8, paid: true },
      { name: "Annual", days: 14, paid: true },
      { name: "Unpaid", days: 0, paid: false },
    ],
  },
  "task-sizes": { sizes: SIZE_RULES.map((r) => ({ size: r.size, meaning: r.meaning, hours: r.hours, points: r.points, days: r.days })) },
  "score-weights": {},
  /*
   * The Director approves every entry, any amount (no CEO tier). Entries above PKR 500,000 and every capital or
   * loan entry are flagged "CEO / Founder / Owner notified" (view only). An entry the Director made is blocked (plan §13).
   */
  "approval-limits": { ceoNotifiedAbove: 500_000, capitalAndLoansNotifyCeo: true, blockIfDirectorMade: true },
  currencies: {
    base: "PKR",
    secondary: "USD",
    revalueAtMonthEnd: true,
    rates: [
      { date: daysFromNow(-1).slice(0, 10), rate: 281.35, by: "ACV-0003" },
      { date: daysFromNow(-8).slice(0, 10), rate: 281.1, by: "ACV-0003" },
      { date: daysFromNow(-15).slice(0, 10), rate: 280.85, by: "ACV-0003" },
      { date: daysFromNow(-22).slice(0, 10), rate: 280.6, by: "ACV-0003" },
      { date: daysFromNow(-29).slice(0, 10), rate: 280.45, by: "ACV-0003" },
    ],
  },
  "finance-year": { startMonth: "07", startDay: "01", currentLabel: "FY 2026–27 (1 July 2026 to 30 June 2027)", reportingFramework: "IFRS for SMEs (accountant to confirm)" },
  "chart-of-accounts": {},
  "tax-slabs": { slabs: DEFAULT_TAX_SLABS },
  security: {
    minLength: 10,
    historyCount: 3,
    lockoutAttempts: 5,
    idleMinutes: 30,
    financeIdleMinutes: 10,
    maxSessionHours: 12,
    resetLinkMinutes: 15,
    twoFactorFor: "levels_1_3_and_finance",
    rememberMeForFinance: false,
    officeOnlyFinance: false,
  },
  "alert-rules": {
    newDevice: true,
    newCity: true,
    outsideHours: true,
    outsideFrom: "20:00",
    outsideTo: "07:00",
    largeExportRows: 500,
    salaryViewsPerHour: 5,
    financeAttempts: 3,
    syncFailingMinutes: 60,
    creditsBelow: 1000,
    bounceRatePct: 3,
  },
  retention: { sessionsYears: 1, actionsYears: 3, financeYears: 10, rawSyncDays: 30, inactiveLeadsMonths: 12, messagesMonths: 24, filesMonths: 36 },
  sales: {
    dailyLeads: 40,
    dailyEmailsChecked: 40,
    dailyEmailsSent: 30,
    dailyFollowUps: 8,
    monthlyMeetings: 8,
    monthlyProposals: 4,
    stages: ["New", "Contacted", "Replied", "Meeting booked", "Proposal sent", "Negotiation", "Won", "Lost"],
    lostReasons: ["Price", "No reply", "Chose another company", "Timing", "Budget cut", "Other"],
    commissionPct: 5,
    commissionBasis: "first_payment",
    recontactMonths: 6,
  },
  "sales-tools": {},
  backups: {},
};

export function seedSettings(): SettingsRecord[] {
  return (Object.keys(SETTINGS) as SettingsSectionKey[]).map((section, i) => ({
    section,
    values: structuredClone(SETTINGS[section]),
    updatedAt: minutesAgo(D * (5 + i * 3)),
    // The Director changes every section (★ sections with step-up); the CEO / Founder / Owner only views.
    updatedBy: "ACV-0003",
  }));
}

export function seedWeightVersions(): WeightsVersion[] {
  return [
    { id: "wv_3", kind: "standard", weights: { quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10 }, effectiveFrom: daysFromNow(-10), createdBy: "ACV-0003", note: "Deadlines matter more after go-live" },
    { id: "wv_2", kind: "sales", weights: { activity: 20, meetings: 25, won: 30, dataQuality: 10, attendance: 15 }, effectiveFrom: daysFromNow(-10), createdBy: "ACV-0003", note: "Starting sales weights (plan §20)" },
    { id: "wv_1", kind: "standard", weights: { quality: 40, onTime: 20, completion: 20, rework: 10, attendance: 10 }, effectiveFrom: daysFromNow(-70), createdBy: "ACV-0003", note: "Trial weights" },
  ];
}

export function seedBackupStatus(): BackupStatus {
  const last = new Date();
  if (last.getHours() < 2) last.setDate(last.getDate() - 1);
  last.setHours(2, 0, 0, 0);
  const next = new Date(last);
  next.setDate(next.getDate() + 1);
  const recent = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(last);
    d.setDate(d.getDate() - i);
    return { id: `bk_${i}`, at: d.toISOString(), kind: d.getDate() === 1 ? ("monthly" as const) : ("daily" as const), sizeMb: 842 - i * 6, ok: true, durationMin: 7 + (i % 3) };
  });
  const restore = (monthsAgo: number, ok = true) => {
    const d = new Date();
    d.setMonth(d.getMonth() - monthsAgo);
    d.setDate(3);
    d.setHours(11, 30, 0, 0);
    return { at: d.toISOString(), ok, by: "ACV-0004", durationMin: 24 + monthsAgo, note: ok ? "Restored to the test server; row counts and the trial balance matched." : "Restore took longer than planned; storage throttled." };
  };
  return {
    lastBackupAt: last.toISOString(),
    ok: true,
    nextBackupAt: next.toISOString(),
    location: "Encrypted S3-compatible storage · separate region",
    encrypted: true,
    dailyCopies: 30,
    dailyKept: 30,
    monthlyCopies: 9,
    monthlyKept: 12,
    recent,
    lastRestoreTest: restore(0),
    restoreTests: [restore(0), restore(1), restore(2, false), restore(3)],
  };
}
