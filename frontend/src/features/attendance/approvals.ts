/**
 * Approvals provider for Module 7 (maker-checker, never the requester, plan §5):
 *  - leave requests: the person's manager first, then the Director when that first step was not the Director
 *    (Development: CTO → Director; CTO, Sales and Finance: Director; Director: CEO / Founder / Owner, the only CEO sign-off);
 *  - attendance corrections: the person's manager (the Director's own goes to the CEO / Founder / Owner).
 * Only the person whose step is waiting gets the item, so anyone else (the CEO / Founder / Owner included) only views it.
 */
import type { ApprovalItem, ApprovalProvider } from "@/features/approvals/types";
import { employeeName, employeesTable } from "@/lib/directory";
import { formatDate, formatTime } from "@/lib/dates";
import { LEAVE_TYPES } from "@/mocks/seed/attendance";
import { tasksTable } from "@/features/tasks/api";
import { isOpen } from "@/features/tasks/logic";
import { isoDay } from "@/lib/dates";
import { applyCorrectionDecision, applyLeaveDecision, correctionsTable, currentLeaveApprover, leaveRequestsTable } from "./api";
import { correctionApprover } from "./logic";

function clashCount(empId: string, from: string, to: string) {
  return tasksTable().filter((t) => t.assignee === empId && !t.personal && isOpen(t.status) && isoDay(t.deadline) >= from && isoDay(t.deadline) <= to).length;
}

export const attendanceApprovals: ApprovalProvider = {
  key: "attendance",
  list: (viewer) => {
    const me = viewer.employee.empId;
    const leave: ApprovalItem[] = (viewer.can("leave.approve") ? leaveRequestsTable() : [])
      .filter((r) => r.empId !== me && currentLeaveApprover(r) === me)
      .map((r) => {
        const type = LEAVE_TYPES.find((t) => t.id === r.leaveTypeId)?.name ?? "Leave";
        const clashes = clashCount(r.empId, r.from, r.to);
        const dates = r.from === r.to ? formatDate(r.from) : `${formatDate(r.from)} – ${formatDate(r.to)}`;
        return {
          id: `leave:${r.id}`,
          type: "leave",
          refId: r.id,
          refNumber: r.number,
          title: `${type} leave · ${r.days} day${r.days === 1 ? "" : "s"}`,
          subtitle: `${dates} · “${r.reason}”${r.status === "pending_director" ? ` · ${r.chain[0]?.label ?? "Manager"} approved` : ""}${clashes ? ` · ${clashes} task deadline${clashes > 1 ? "s" : ""} fall in this leave` : ""}`,
          requester: r.empId,
          from: r.from,
          to: r.to,
          createdAt: r.at,
          href: "/leave?tab=approvals",
        };
      });
    const corrections: ApprovalItem[] = (viewer.can("attendance.approve_correction") ? correctionsTable() : [])
      .filter((c) => c.status === "pending" && c.empId !== me)
      .filter((c) => correctionApprover(c.empId, employeesTable())?.empId === me)
      .map((c) => ({
        id: `attendance_correction:${c.id}`,
        type: "attendance_correction",
        refId: c.id,
        title: `Attendance correction for ${formatDate(c.date)}`,
        subtitle: `${c.original.checkIn ? formatTime(c.original.checkIn) : "no check-in"} → ${c.requested.checkIn ? formatTime(c.requested.checkIn) : "—"}, out ${c.original.checkOut ? formatTime(c.original.checkOut) : "—"} → ${c.requested.checkOut ? formatTime(c.requested.checkOut) : "—"} · “${c.reason}” · ${employeeName(c.empId)}`,
        requester: c.empId,
        createdAt: c.at,
        href: "/attendance?tab=corrections",
      }));
    return [...leave, ...corrections];
  },
  decide: (item, decision, viewer, opts) => {
    const me = viewer.employee.empId;
    if (item.type === "leave" && viewer.can("leave.approve")) {
      const r = leaveRequestsTable().find((x) => x.id === item.refId);
      if (r && r.empId !== me && currentLeaveApprover(r) === me) applyLeaveDecision(r, decision === "approve", me, opts.reason);
    }
    if (item.type === "attendance_correction" && viewer.can("attendance.approve_correction")) {
      const c = correctionsTable().find((x) => x.id === item.refId);
      if (c && c.status === "pending" && c.empId !== me && correctionApprover(c.empId, employeesTable())?.empId === me) applyCorrectionDecision(c, decision === "approve", me, opts.reason);
    }
  },
};
