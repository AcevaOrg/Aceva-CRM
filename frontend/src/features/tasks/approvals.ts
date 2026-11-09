/**
 * Approvals provider for Module 5: task reviews and deadline extensions.
 * Reviewer = the person who assigned the task (plan §10).
 */
import type { ApprovalProvider } from "@/features/approvals/types";
import { employeeName } from "@/lib/directory";
import { formatDate } from "@/lib/dates";
import { extensionsTable, tasksTable } from "./api";
import { sizeRule } from "./logic";

export const taskApprovals: ApprovalProvider = {
  key: "tasks",
  list: (viewer) => {
    const me = viewer.employee.empId;
    const tasks = tasksTable();
    const reviews = tasks
      .filter((t) => !t.personal && t.assignedBy === me && (t.status === "submitted" || t.status === "under_review"))
      .map((t) => ({
        id: `task_review:${t.id}`,
        type: "task_review" as const,
        refId: t.id,
        refNumber: t.number,
        title: t.title,
        subtitle: `${t.size} task · ${sizeRule(t.size).points} pts · submitted by ${employeeName(t.assignee)}`,
        requester: t.assignee,
        createdAt: t.submittedAt ?? t.updatedAt,
        href: `/tasks/${t.id}`,
        needsRating: true,
        approveLabel: "Approve",
        rejectLabel: "Send to rework",
      }));
    const extensions = extensionsTable()
      .filter((e) => e.status === "pending")
      .map((e) => ({ e, t: tasks.find((t) => t.id === e.taskId) }))
      .filter(({ t }) => t && t.assignedBy === me)
      .map(({ e, t }) => ({
        id: `extension:${e.id}`,
        type: "extension" as const,
        refId: e.id,
        refNumber: t!.number,
        title: `More time for “${t!.title}”`,
        subtitle: `${formatDate(e.currentDeadline)} → ${formatDate(e.requestedDeadline)} · “${e.reason}”${e.late ? " · asked after the deadline (counts as late)" : ""}`,
        requester: e.requestedBy,
        from: e.currentDeadline,
        to: e.requestedDeadline,
        createdAt: e.at,
        href: `/tasks/${t!.id}`,
      }));
    return [...reviews, ...extensions];
  },
  decide: (item, decision, viewer, opts) => {
    const me = viewer.employee.empId;
    const now = new Date().toISOString();
    if (item.type === "task_review") {
      const t = tasksTable().find((x) => x.id === item.refId);
      if (!t) return;
      t.status = decision === "approve" ? "approved" : "rework";
      if (decision === "approve") t.rating = (opts.rating ?? 4) as 1 | 2 | 3 | 4 | 5;
      else t.reviewComment = opts.reason;
      t.updatedAt = now;
    }
    if (item.type === "extension") {
      const e = extensionsTable().find((x) => x.id === item.refId);
      if (!e) return;
      e.status = decision === "approve" ? "approved" : "rejected";
      e.decidedBy = me;
      e.decidedAt = now;
      const t = tasksTable().find((x) => x.id === e.taskId);
      if (t && decision === "approve") {
        t.deadline = e.requestedDeadline;
        t.extensionsCount += 1;
      }
    }
  },
};
