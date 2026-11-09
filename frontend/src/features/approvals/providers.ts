/**
 * Every module that has approvals registers its provider here (spec §4.5).
 * Order = order of tabs in the inbox.
 */
import { taskApprovals } from "@/features/tasks/approvals";
import { attendanceApprovals } from "@/features/attendance/approvals";
import { ledgerApprovals } from "@/features/ledger/approvals";
import { payrollApprovals } from "@/features/payroll/approvals";
import { salesApprovals } from "@/features/sales/approvals";
import { performanceApprovals } from "@/features/performance/approvals";
import type { ApprovalProvider } from "./types";

export const PROVIDERS: ApprovalProvider[] = [
  taskApprovals,
  attendanceApprovals,
  ledgerApprovals,
  payrollApprovals,
  salesApprovals,
  performanceApprovals,
];
