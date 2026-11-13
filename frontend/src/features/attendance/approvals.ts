/**
 * Approvals provider for Module 7 (maker-checker, never the requester, plan §5):
 *  - leave requests: the person's manager first, then the Director when that first step was not the Director
 *    (Development: CTO → Director; CTO, Sales and Finance: Director; Director: CEO / Founder / Owner, the only CEO sign-off);
 *  - attendance corrections: the person's manager (the Director's own goes to the CEO / Founder / Owner).
 * Only the person whose step is waiting gets the item, so anyone else (the CEO / Founder / Owner included) only views it.
 * Live (m7): the items and the decisions come from the server (see liveList / liveDecide below).
 */
import { toast } from "sonner";
import type { CorrectionView, LeaveRequestView, Page } from "@aceva/contracts";
import type { ApprovalItem, ApprovalProvider } from "@/features/approvals/types";
import { http, isLive } from "@/lib/api/http";
import { employeeName, employeesTable } from "@/lib/directory";
import { formatDate, formatTime } from "@/lib/dates";
import { LEAVE_TYPES } from "@/mocks/seed/attendance";
import { tasksTable } from "@/features/tasks/api";
import { isOpen } from "@/features/tasks/logic";
import { isoDay } from "@/lib/dates";
import { applyCorrectionDecision, applyLeaveDecision, correctionsTable, currentLeaveApprover, leaveRequestsTable } from "./api";
import { correctionApprover } from "./logic";
import { refreshQueries } from "./today";

function clashCount(empId: string, from: string, to: string) {
  return tasksTable().filter((t) => t.assignee === empId && !t.personal && isOpen(t.status) && isoDay(t.deadline) >= from && isoDay(t.deadline) <= to).length;
}

/* ---------------- Live (m7): the server routes and decides ---------------- */

/**
 * The inbox asks providers synchronously, so in live mode this keeps the items the SERVER says are waiting for the viewer
 * (canDecide = the viewer is the Module 1 routed approver of the current step) and refreshes them in the background.
 * Nothing is decided here: approve / reject call the server, which checks routing, self-approval and locked months again.
 */
const liveCache: { empId: string | null; at: number; items: ApprovalItem[]; loading: boolean } = { empId: null, at: 0, items: [], loading: false };

async function loadLive(empId: string) {
  liveCache.loading = true;
  try {
    const [leave, corrections, types] = await Promise.all([
      http.get<Page<LeaveRequestView>>("/leave/requests", { scope: "team", status: "pending", pageSize: 200 }),
      http.get<Page<CorrectionView>>("/attendance/corrections", { scope: "team", status: "pending", pageSize: 200 }).catch(() => ({ items: [] as CorrectionView[] })),
      http.get<Array<{ id: string; name: string }>>("/leave/types", { includeArchived: "true" }),
    ]);
    const typeName = new Map(types.map((t) => [t.id, t.name]));
    const items: ApprovalItem[] = [
      ...leave.items.filter((r) => r.canDecide).map((r): ApprovalItem => {
        const dates = r.from === r.to ? formatDate(r.from) : `${formatDate(r.from)} – ${formatDate(r.to)}`;
        const first = r.chain.find((c) => c.step === 1);
        return {
          id: `leave:${r.id}`,
          type: "leave",
          refId: r.id,
          refNumber: r.number,
          title: `${typeName.get(r.leaveTypeId) ?? r.leaveTypeName} leave · ${r.days} day${r.days === 1 ? "" : "s"}`,
          subtitle: `${dates} · “${r.reason}”${r.status === "pending_director" && first ? ` · ${first.label} approved` : ""}`,
          requester: r.empId,
          from: r.from,
          to: r.to,
          createdAt: r.createdAt,
          href: "/leave?tab=approvals",
        };
      }),
      ...corrections.items.filter((c) => c.canDecide).map((c): ApprovalItem => ({
        id: `attendance_correction:${c.id}`,
        type: "attendance_correction",
        refId: c.id,
        title: `Attendance correction for ${formatDate(c.date)}`,
        subtitle: `${c.original.checkIn ? formatTime(c.original.checkIn) : "no check-in"} → ${c.requested.checkIn ? formatTime(c.requested.checkIn) : "—"}, out ${c.original.checkOut ? formatTime(c.original.checkOut) : "—"} → ${c.requested.checkOut ? formatTime(c.requested.checkOut) : "—"} · “${c.reason}” · ${c.name}`,
        requester: c.empId,
        createdAt: c.createdAt,
        href: "/attendance?tab=corrections",
      })),
    ];
    const changed = JSON.stringify(items.map((i) => i.id)) !== JSON.stringify(liveCache.items.map((i) => i.id)) || liveCache.empId !== empId;
    Object.assign(liveCache, { empId, at: Date.now(), items });
    if (changed) refreshQueries(["approvals"]);
  } catch {
    liveCache.at = Date.now();
  } finally {
    liveCache.loading = false;
  }
}

function liveList(empId: string): ApprovalItem[] {
  const stale = liveCache.empId !== empId || Date.now() - liveCache.at > 30_000;
  if (stale && !liveCache.loading) void loadLive(empId);
  return liveCache.empId === empId ? liveCache.items : [];
}

function liveDecide(item: ApprovalItem, approve: boolean, reason?: string) {
  const path = item.type === "leave" ? `/leave/requests/${item.refId}` : `/attendance/corrections/${item.refId}`;
  const call = approve ? http.post(`${path}/approve`, { note: reason || undefined }) : http.post(`${path}/reject`, { reason: reason ?? "" });
  liveCache.items = liveCache.items.filter((i) => i.id !== item.id);
  void call
    .catch((e: Error) => toast.error(e.message))
    .finally(() => {
      liveCache.at = 0;
      refreshQueries();
    });
}

export const attendanceApprovals: ApprovalProvider = {
  key: "attendance",
  list: (viewer) => {
    if (isLive("m7")) return liveList(viewer.employee.empId);
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
    if (isLive("m7")) return liveDecide(item, decision === "approve", opts.reason);
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
