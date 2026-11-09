/**
 * Approvals provider for Module 6:
 *  - draft scorecards: the next level up reviews and releases them (can add a remark, never change numbers)
 *  - rating disputes: decided by the level above the reviewer (plan §10)
 */
import type { ApprovalItem, ApprovalProvider } from "@/features/approvals/types";
import { employeeName } from "@/lib/directory";
import { formatMonthKey } from "@/lib/dates";
import { applyDisputeDecision, applyRelease, disputesTable, scorecardsTable } from "./api";
import { BAND_LABEL } from "./logic";

export const performanceApprovals: ApprovalProvider = {
  key: "performance",
  list: (viewer) => {
    const me = viewer.employee.empId;
    const drafts: ApprovalItem[] = scorecardsTable()
      .filter((s) => s.status === "draft" && s.reviewerEmpId === me && s.empId !== me)
      .map((s) => ({
        id: `scorecard:${s.id}`,
        type: "scorecard",
        refId: s.id,
        title: `${formatMonthKey(s.month)} scorecard · ${Math.round(s.score)} (${BAND_LABEL[s.band]})`,
        subtitle: `${employeeName(s.empId)} · ${s.kind === "sales" ? "sales weights" : `${s.taskCount} tasks`}${s.smallSample ? " · small sample" : ""}. Review and release; you can add a remark but not change the numbers.`,
        requester: s.empId,
        createdAt: s.createdAt,
        href: `/performance/scorecards/${s.id}`,
        approveLabel: "Release",
        rejectLabel: "Add remark, keep draft",
      }));
    const disputes: ApprovalItem[] = disputesTable()
      .filter((d) => d.status === "open" && d.deciderEmpId === me && d.empId !== me)
      .map((d) => ({
        id: `dispute:${d.id}`,
        type: "dispute",
        refId: d.id,
        refNumber: d.taskNumber,
        title: `Rating dispute: ${d.taskTitle} (${d.currentRating}★)`,
        subtitle: `“${d.reason}”`,
        requester: d.empId,
        createdAt: d.at,
        href: `/performance/scorecards/${d.scorecardId}`,
        needsRating: true,
        approveLabel: "Change rating",
        rejectLabel: "Keep rating",
      }));
    return [...drafts, ...disputes];
  },
  decide: (item, decision, viewer, opts) => {
    const me = viewer.employee.empId;
    if (item.type === "scorecard") {
      const sc = scorecardsTable().find((s) => s.id === item.refId);
      if (!sc || sc.reviewerEmpId !== me) return;
      if (decision === "approve") applyRelease(sc, opts.reason);
      else if (opts.reason) {
        sc.reviewerRemark = opts.reason;
        sc.remarkAt = new Date().toISOString();
      }
    }
    if (item.type === "dispute") {
      const d = disputesTable().find((x) => x.id === item.refId);
      if (!d || d.deciderEmpId !== me || d.status !== "open") return;
      if (decision === "approve") applyDisputeDecision(d, true, me, opts.reason ?? "Rating changed after review.", opts.rating);
      else applyDisputeDecision(d, false, me, opts.reason ?? "Rating kept.");
    }
  },
};
