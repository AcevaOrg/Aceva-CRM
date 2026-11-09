/**
 * Approvals provider for Module 9 (spec §2.3, maker-checker):
 *   Journal entries: made by the finance person → approved by the Director, any amount.
 *     Entries above PKR 500,000 and every capital or loan entry are flagged "CEO / Founder / Owner notified" (view only).
 *   Month close: run by the finance person → approved by the Director.
 * The CEO / Founder / Owner approves nothing here.
 */
import type { ApprovalItem, ApprovalProvider } from "@/features/approvals/types";
import { formatMonthKey } from "@/lib/dates";
import { canApproveClose, CEO_NOTIFIED_LABEL, SOURCE_LABEL } from "./logic";
import { approveClose, approveEntry, entriesTable, periodsTable, rejectClose, rejectEntry } from "./store";

export const ledgerApprovals: ApprovalProvider = {
  key: "ledger",
  list: (viewer) => {
    const me = viewer.employee.empId;
    const entries: ApprovalItem[] = viewer.can("finance.entry_approve")
      ? entriesTable()
          .filter((e) => e.status === "pending_approval" && !e.blocked && e.approverEmpId === me && e.createdBy !== me)
          .map((e) => ({
            id: `journal_entry:${e.id}`,
            type: "journal_entry" as const,
            refId: e.id,
            refNumber: e.number,
            title: e.description,
            subtitle: `${SOURCE_LABEL[e.source]} · Prepared by Finance${e.ceoNotified ? ` · ${CEO_NOTIFIED_LABEL}` : ""}${e.currency === "USD" ? ` · USD at ${Number(e.exchangeRate).toFixed(2)}` : ""}`,
            requester: e.createdBy,
            amount: e.baseTotal,
            createdAt: e.createdAt,
            href: `/finance/ledger/${e.id}`,
            needsStepUp: !!e.ceoNotified,
            approveLabel: "Approve and post",
          }))
      : [];
    // The Director approves a month close the finance person ran, never one they ran themselves.
    const closes: ApprovalItem[] = (canApproveClose(viewer.can) ? periodsTable() : [])
      .filter((p) => p.status === "closing" && p.closedBy && p.closedBy !== me)
      .map((p) => ({
        id: `month_close:${p.month}`,
        type: "month_close" as const,
        refId: p.month,
        refNumber: p.month,
        title: `Close ${formatMonthKey(p.month)}`,
        subtitle: "Run by Finance. Checklist complete. Approving locks the month and saves the statements as a snapshot.",
        requester: p.closedBy!,
        createdAt: p.closedAt ?? new Date().toISOString(),
        href: "/finance/close",
        needsStepUp: true,
        approveLabel: "Approve close",
      }));
    return [...entries, ...closes];
  },
  decide: (item, decision, viewer, opts) => {
    const me = viewer.employee.empId;
    if (item.type === "journal_entry") {
      if (decision === "approve") approveEntry(item.refId, me);
      else rejectEntry(item.refId, me, opts.reason ?? "Sent back");
    }
    if (item.type === "month_close") {
      if (decision === "approve") approveClose(item.refId, me);
      else rejectClose(item.refId, me, opts.reason ?? "Sent back");
    }
  },
  routedUp: (viewer) => entriesTable().filter((e) => e.status === "pending_approval" && e.createdBy === viewer.employee.empId).length,
};
