/**
 * Approvals inbox (cross-module, spec §4.5).
 * Each module exposes an ApprovalProvider in features/<module>/approvals.ts;
 * the inbox lists items from all providers in one place.
 */
import type { Viewer } from "@/lib/auth/viewer";
import type { Money } from "@/types";

export type ApprovalType =
  | "task_review"
  | "extension"
  | "leave"
  | "attendance_correction"
  | "journal_entry"
  | "payroll"
  | "month_close"
  | "commission"
  | "won_deal"
  | "scorecard"
  | "dispute";

export const APPROVAL_TYPE_LABEL: Record<ApprovalType, string> = {
  task_review: "Task reviews",
  extension: "Extensions",
  leave: "Leave",
  attendance_correction: "Attendance corrections",
  journal_entry: "Journal entries",
  payroll: "Payroll",
  month_close: "Month close",
  commission: "Commission",
  won_deal: "Won deals",
  scorecard: "Scorecards",
  dispute: "Rating disputes",
};

export interface ApprovalItem {
  /** Unique across providers, e.g. "leave:lv_12". */
  id: string;
  type: ApprovalType;
  refId: string;
  refNumber?: string;
  title: string;
  subtitle?: string;
  requester: string;
  amount?: Money;
  from?: string;
  to?: string;
  createdAt: string;
  href: string;
  needsStepUp?: boolean;
  /** Task reviews need a 1–5 rating on approve. */
  needsRating?: boolean;
  approveLabel?: string;
  rejectLabel?: string;
  /** Oversight lists only: the Emp-ID of the person who must decide. */
  waitingFor?: string;
}

export interface DecideOptions {
  reason?: string;
  rating?: number;
}

export interface ApprovalProvider {
  key: string;
  /** Items waiting for this viewer (already excluding what they made). */
  list: (viewer: Viewer) => ApprovalItem[];
  decide: (item: ApprovalItem, decision: "approve" | "reject", viewer: Viewer, opts: DecideOptions) => void;
  /** How many items this viewer made that were routed to someone else (maker-checker). */
  routedUp?: (viewer: Viewer) => number;
}
