/**
 * Approvals provider for Module 8 (decision D25, replacing plan §12's "Director reviews, CEO approves"):
 * Prepared (Finance) → Approved (Director, step-up), one step. The person who prepared a run never sees it here
 * (maker-checker); it is counted in routedUp. The CEO and the Owner view every run but approve none.
 * A run reviewed before D25 (stage "reviewed") is still approved here, by someone other than its reviewer.
 *
 * Mock mode reads the in-browser tables. Live mode lists from the runs last read from the server (the inbox providers are
 * synchronous) and sends the decision to the server, which checks permission, stage, maker-checker and the step-up again.
 */
import { toast } from "sonner";
import type { ApprovalItem, ApprovalProvider } from "@/features/approvals/types";
import { isLive } from "@/lib/api/http";
import { employeeName } from "@/lib/directory";
import { formatMonthKey } from "@/lib/dates";
import { runsTable, withApprovalChain } from "./api";
import { liveRunCache, livePayrollApi } from "./live-api";
import { PAYROLL_PREPARER } from "./logic";
import type { PayrollRun } from "./types";

/** Chain positions: 0 Prepared (Finance), 1 Approved (Director). */
const APPROVED = 1;
const live = () => isLive("m8");
const waiting = (r: PayrollRun) => r.stage === "prepared" || r.stage === "reviewed";

function runs(): PayrollRun[] {
  if (!live()) return runsTable().map(withApprovalChain);
  const cache = liveRunCache();
  // Refresh in the background when the list is old; the inbox re-reads it on its next refresh.
  if (Date.now() - cache.at > 60_000) void livePayrollApi.listRuns().catch(() => undefined);
  return cache.runs;
}

export const payrollApprovals: ApprovalProvider = {
  key: "payroll",
  list: (viewer) => {
    const me = viewer.employee.empId;
    const items: ApprovalItem[] = [];
    if (!viewer.can("payroll.approve")) return items;
    for (const run of runs()) {
      if (run.preparedBy === me || run.reviewedBy === me || !waiting(run)) continue;
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
    if (live()) {
      const action = decision === "approve" ? "approve" : "return";
      void livePayrollApi.act(item.refId, action, { note: opts.reason }).then(
        () => toast.success(decision === "approve" ? "Payroll approved" : "Sent back to Finance"),
        (e: Error) => toast.error(e.message),
      );
      return;
    }
    const run = runsTable().find((r) => r.id === item.refId);
    const me = viewer.employee.empId;
    if (!run || run.preparedBy === me || run.reviewedBy === me) return;
    withApprovalChain(run);
    if (!waiting(run) || !viewer.can("payroll.approve")) return;
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
      run.reviewedBy = undefined;
      run.reviewedAt = undefined;
    }
  },
  routedUp: (viewer) => runs().filter((r) => r.preparedBy === viewer.employee.empId && waiting(r)).length,
};
