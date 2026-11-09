/**
 * Approvals provider for Module 9: journal entries (routed by amount level, maker-checker)
 * and month close (CEO approves what the finance duty person ran).
 */
import type { ApprovalItem, ApprovalProvider } from "@/features/approvals/types";
import { employeesTable } from "@/lib/directory";
import { formatMonthKey } from "@/lib/dates";
import { approverFor, LEVEL_APPROVER_TITLE, SOURCE_LABEL } from "./logic";
import { approveClose, approveEntry, entriesTable, periodsTable, rejectClose, rejectEntry } from "./store";

export const ledgerApprovals: ApprovalProvider = {
  key: "ledger",
  list: (viewer) => {
    if (!viewer.can("finance.entry_approve") && !viewer.can("finance.close")) return [];
    const me = viewer.employee.empId;
    const entries: ApprovalItem[] = viewer.can("finance.entry_approve")
      ? entriesTable()
          .filter((e) => e.status === "pending_approval" && e.approverEmpId === me)
          .map((e) => ({
            id: `journal_entry:${e.id}`,
            type: "journal_entry" as const,
            refId: e.id,
            refNumber: e.number,
            title: e.description,
            subtitle: `${SOURCE_LABEL[e.source]} · needs ${LEVEL_APPROVER_TITLE[e.requiredApproverLevel]} approval${e.currency === "USD" ? ` · USD at ${Number(e.exchangeRate).toFixed(2)}` : ""}`,
            requester: e.createdBy,
            amount: e.baseTotal,
            createdAt: e.createdAt,
            href: `/finance/ledger/${e.id}`,
            needsStepUp: e.requiredApproverLevel <= 2,
            approveLabel: "Approve and post",
          }))
      : [];
    const closes: ApprovalItem[] = periodsTable()
      .filter((p) => p.status === "closing" && p.closedBy && approverFor(2, p.closedBy, employeesTable()).empId === me)
      .map((p) => ({
        id: `month_close:${p.month}`,
        type: "month_close" as const,
        refId: p.month,
        refNumber: p.month,
        title: `Close ${formatMonthKey(p.month)}`,
        subtitle: "Checklist complete. Approving locks the month and saves the statements as a snapshot.",
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
