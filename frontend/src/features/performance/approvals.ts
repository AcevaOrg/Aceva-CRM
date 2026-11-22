/**
 * Approvals provider for Module 6:
 *  - draft scorecards: the reviewer (the person's manager, or the next level up who reviews work) releases them; they
 *    can add a remark, never change numbers
 *    (Development → CTO; CTO, Sales and Finance → Director). The Director's own scorecard has no reviewer: it is
 *    released automatically and the CEO / Founder / Owner views it (the CEO releases nothing).
 *  - rating disputes: decided by the level above the task's reviewer (plan §10); the CEO / Founder / Owner decides none.
 * Live (Module 6 switched on) the server's inbox holds these items (GET /approvals, POST /approvals/:id/approve|reject:
 * see features/approvals/api.ts: "scorecard:<id>" release or remark, "dispute:<id>" change or keep the rating), so this
 * mock provider gives none and decides nothing: the same item must never appear twice.
 */
import type { ApprovalItem, ApprovalProvider } from "@/features/approvals/types";
import { isLive } from "@/lib/api/http";
import { employeeName } from "@/lib/directory";
import { formatMonthKey } from "@/lib/dates";
import { applyDisputeDecision, applyRelease, disputesTable, scorecardsTable } from "./api";
import { scoreText } from "./logic";

export const performanceApprovals: ApprovalProvider = {
  key: "performance",
  list: (viewer) => {
    if (isLive("m6")) return [];
    const me = viewer.employee.empId;
    // Only people who review work (the Director and the CTO) release scorecards and decide disputes.
    if (!viewer.can("task.review")) return [];
    const drafts: ApprovalItem[] = scorecardsTable()
      .filter((s) => s.status === "draft" && s.reviewerEmpId === me && s.empId !== me)
      .map((s) => ({
        id: `scorecard:${s.id}`,
        type: "scorecard",
        refId: s.id,
        title: `${formatMonthKey(s.month)} scorecard · ${scoreText(s.score, s.band)}`,
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
    if (isLive("m6")) return;
    const me = viewer.employee.empId;
    if (!viewer.can("task.review")) return;
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
