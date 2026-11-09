/**
 * Approvals provider for Module 8: payroll review (Director) and approval (CEO, step-up).
 * Maker-checker: the person who prepared a run never sees it here; it is counted in routedUp.
 */
import type { ApprovalItem, ApprovalProvider } from "@/features/approvals/types";
import { employeeName } from "@/lib/directory";
import { formatMonthKey } from "@/lib/dates";
import { runsTable } from "./api";

export const payrollApprovals: ApprovalProvider = {
  key: "payroll",
  list: (viewer) => {
    const me = viewer.employee.empId;
    const items: ApprovalItem[] = [];
    for (const run of runsTable()) {
      if (run.preparedBy === me) continue;
      const base = {
        type: "payroll" as const,
        refId: run.id,
        refNumber: run.number,
        requester: run.preparedBy ?? "ACV-0010",
        amount: run.totals.net,
        createdAt: run.reviewedAt ?? run.preparedAt ?? run.createdAt,
        href: `/payroll/runs/${run.id}`,
      };
      if (run.stage === "prepared" && viewer.can("payroll.review") && viewer.employee.level === 3) {
        items.push({
          ...base,
          id: `payroll:${run.id}:review`,
          title: `Review ${formatMonthKey(run.month)} payroll`,
          subtitle: `${run.headcount} people · prepared by ${employeeName(run.preparedBy)}`,
          approveLabel: "Mark reviewed",
          rejectLabel: "Send back",
        });
      }
      if (run.stage === "reviewed" && viewer.can("payroll.approve")) {
        items.push({
          ...base,
          id: `payroll:${run.id}:approve`,
          title: `Approve ${formatMonthKey(run.month)} payroll`,
          subtitle: `${run.headcount} people · prepared by ${employeeName(run.preparedBy)}, reviewed by ${employeeName(run.reviewedBy)}`,
          needsStepUp: true,
          approveLabel: "Approve payroll",
          rejectLabel: "Send back",
        });
      }
    }
    return items;
  },
  decide: (item, decision, viewer, opts) => {
    const run = runsTable().find((r) => r.id === item.refId);
    if (!run || run.preparedBy === viewer.employee.empId) return;
    const me = viewer.employee.empId;
    const now = new Date().toISOString();
    const isApprove = item.id.endsWith(":approve");
    const i = isApprove ? 2 : 1;
    if (decision === "approve") {
      run.chain[i] = { ...run.chain[i], empId: me, state: "done", at: now };
      if (isApprove) {
        run.stage = "approved";
        run.approvedBy = me;
        run.approvedAt = now;
      } else {
        run.stage = "reviewed";
        run.reviewedBy = me;
        run.reviewedAt = now;
        run.chain[2] = { ...run.chain[2], state: "waiting" };
      }
    } else {
      run.chain[i] = { ...run.chain[i], empId: me, state: "rejected", at: now, note: opts.reason };
      run.stage = "calculated";
      run.returnedNote = opts.reason;
    }
  },
  routedUp: (viewer) =>
    runsTable().filter((r) => r.preparedBy === viewer.employee.empId && (r.stage === "prepared" || r.stage === "reviewed")).length,
};
