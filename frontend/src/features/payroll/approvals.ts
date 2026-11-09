/**
 * Approvals provider for Module 8: payroll approval by the Director (step-up).
 * Chain: Prepared (Finance) → Approved (Director). There is no CEO step: the CEO / Founder / Owner
 * views every run but approves nothing. The maker can't also be the checker: whoever prepared a run
 * never sees it here; it is counted in routedUp.
 */
import type { ApprovalItem, ApprovalProvider } from "@/features/approvals/types";
import { employeeName } from "@/lib/directory";
import { formatMonthKey } from "@/lib/dates";
import { runsTable } from "./api";
import { PAYROLL_PREPARER } from "./logic";

/** Chain position of the "Approved (Director)" step. */
const APPROVED = 1;

export const payrollApprovals: ApprovalProvider = {
  key: "payroll",
  list: (viewer) => {
    const me = viewer.employee.empId;
    const items: ApprovalItem[] = [];
    if (!viewer.can("payroll.approve")) return items;
    for (const run of runsTable()) {
      if (run.preparedBy === me || run.stage !== "prepared") continue;
      items.push({
        type: "payroll",
        refId: run.id,
        refNumber: run.number,
        requester: run.preparedBy ?? PAYROLL_PREPARER,
        amount: run.totals.net,
        createdAt: run.preparedAt ?? run.createdAt,
        href: `/payroll/runs/${run.id}`,
        id: `payroll:${run.id}:approve`,
        title: `Approve ${formatMonthKey(run.month)} payroll`,
        subtitle: `${run.headcount} people · prepared by ${employeeName(run.preparedBy)} (Finance)`,
        needsStepUp: true,
        approveLabel: "Approve payroll",
        rejectLabel: "Send back",
      });
    }
    return items;
  },
  decide: (item, decision, viewer, opts) => {
    const run = runsTable().find((r) => r.id === item.refId);
    const me = viewer.employee.empId;
    if (!run || run.stage !== "prepared" || run.preparedBy === me || !viewer.can("payroll.approve")) return;
    const now = new Date().toISOString();
    if (decision === "approve") {
      run.chain[APPROVED] = { ...run.chain[APPROVED], empId: me, state: "done", at: now };
      run.stage = "approved";
      run.approvedBy = me;
      run.approvedAt = now;
    } else {
      run.chain[APPROVED] = { ...run.chain[APPROVED], empId: me, state: "rejected", at: now, note: opts.reason };
      run.stage = "calculated";
      run.returnedNote = opts.reason;
    }
  },
  routedUp: (viewer) => runsTable().filter((r) => r.preparedBy === viewer.employee.empId && r.stage === "prepared").length,
};
