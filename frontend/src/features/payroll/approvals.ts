/**
 * Approvals provider for Module 8 (plan §12): Prepared (Finance) → Reviewed (Director) → Approved (CEO, step-up).
 * The person who prepared a run never sees it here (maker-checker); it is counted in routedUp. The Owner views every run
 * but approves nothing.
 *
 * Mock mode reads the in-browser tables. Live mode lists from the runs last read from the server (the inbox providers are
 * synchronous) and sends the decision to the server, which checks permission, stage, maker-checker and the step-up again.
 */
import { toast } from "sonner";
import type { ApprovalItem, ApprovalProvider } from "@/features/approvals/types";
import { isLive } from "@/lib/api/http";
import { employeeName } from "@/lib/directory";
import { formatMonthKey } from "@/lib/dates";
import { runsTable, withReviewStep } from "./api";
import { liveRunCache, livePayrollApi } from "./live-api";
import { PAYROLL_PREPARER } from "./logic";
import type { PayrollRun } from "./types";

/** Chain positions: 0 Prepared, 1 Reviewed (Director), 2 Approved (CEO). */
const REVIEWED = 1;
const APPROVED = 2;
const live = () => isLive("m8");

function runs(): PayrollRun[] {
  if (!live()) return runsTable().map(withReviewStep);
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
    const canReview = viewer.can("payroll.review");
    const canApprove = viewer.can("payroll.approve");
    if (!canReview && !canApprove) return items;
    for (const run of runs()) {
      if (run.preparedBy === me) continue;
      const step = run.stage === "prepared" && canReview ? "review" : run.stage === "reviewed" && canApprove ? "approve" : null;
      if (!step) continue;
      items.push({
        type: "payroll",
        refId: run.id,
        refNumber: run.number,
        requester: run.preparedBy ?? PAYROLL_PREPARER,
        amount: run.totals.net,
        createdAt: (step === "review" ? run.preparedAt : run.reviewedAt) ?? run.createdAt,
        href: `/payroll/runs/${run.id}`,
        id: `payroll:${run.id}:${step}`,
        title: step === "review" ? `Review ${formatMonthKey(run.month)} payroll` : `Approve ${formatMonthKey(run.month)} payroll`,
        subtitle:
          step === "review"
            ? `${run.headcount} people · prepared by ${employeeName(run.preparedBy)} (Finance)`
            : `${run.headcount} people · prepared by ${employeeName(run.preparedBy)}, reviewed by ${employeeName(run.reviewedBy)} (Director)`,
        needsStepUp: step === "approve",
        approveLabel: step === "review" ? "Mark reviewed" : "Approve payroll",
        rejectLabel: "Send back",
      });
    }
    return items;
  },
  decide: (item, decision, viewer, opts) => {
    const step = item.id.endsWith(":approve") ? "approve" : "review";
    if (live()) {
      const action = decision === "approve" ? step : "return";
      void livePayrollApi.act(item.refId, action, { note: opts.reason }).then(
        () => toast.success(decision === "approve" ? (step === "approve" ? "Payroll approved" : "Payroll reviewed") : "Sent back to Finance"),
        (e: Error) => toast.error(e.message),
      );
      return;
    }
    const run = runsTable().find((r) => r.id === item.refId);
    const me = viewer.employee.empId;
    if (!run || run.preparedBy === me) return;
    withReviewStep(run);
    const now = new Date().toISOString();
    const index = step === "approve" ? APPROVED : REVIEWED;
    if (step === "review" && (run.stage !== "prepared" || !viewer.can("payroll.review"))) return;
    if (step === "approve" && (run.stage !== "reviewed" || !viewer.can("payroll.approve"))) return;
    if (decision === "approve") {
      run.chain[index] = { ...run.chain[index], empId: me, state: "done", at: now };
      if (step === "review") {
        run.stage = "reviewed";
        run.reviewedBy = me;
        run.reviewedAt = now;
        run.chain[APPROVED] = { ...run.chain[APPROVED], state: "waiting" };
      } else {
        run.stage = "approved";
        run.approvedBy = me;
        run.approvedAt = now;
      }
    } else {
      run.chain[index] = { ...run.chain[index], empId: me, state: "rejected", at: now, note: opts.reason };
      run.stage = "calculated";
      run.returnedNote = opts.reason;
      run.reviewedBy = undefined;
      run.reviewedAt = undefined;
    }
  },
  routedUp: (viewer) => runs().filter((r) => r.preparedBy === viewer.employee.empId && (r.stage === "prepared" || r.stage === "reviewed")).length,
};
