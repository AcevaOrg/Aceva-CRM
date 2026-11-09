"use client";
import { toast } from "sonner";
import { Check, Eye, TriangleAlert, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ApprovalRelay } from "@/components/shared/approval-relay";
import { StatusBadge } from "@/components/shared/chips";
import { useReason } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { Mono } from "@/components/shared/money";
import { useTasks } from "@/features/tasks/hooks";
import { isOpen } from "@/features/tasks/logic";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatRelative, isoDay } from "@/lib/dates";
import { currentLeaveApprover } from "../api";
import { useCancelLeave, useDecideLeave, useLeaveBalances, useLeaveTypes } from "../hooks";
import { isPendingLeave, LEAVE_STATUS, leaveStatusLabel } from "../logic";
import type { LeaveRequest } from "../types";

export function leaveDates(r: Pick<LeaveRequest, "from" | "to" | "halfDay">) {
  if (r.from === r.to) return `${formatDate(r.from)}${r.halfDay ? " (half day)" : ""}`;
  return `${formatDate(r.from)} – ${formatDate(r.to)}`;
}

function ApproverContext({ r }: { r: LeaveRequest }) {
  const bal = useLeaveBalances(r.empId);
  const tasks = useTasks({ scope: "team" });
  const b = bal.data?.find((x) => x.leaveTypeId === r.leaveTypeId);
  const clashes = (tasks.data ?? []).filter((t) => t.assignee === r.empId && isOpen(t.status) && isoDay(t.deadline) >= r.from && isoDay(t.deadline) <= r.to);
  return (
    <div className="grid gap-1.5 rounded-lg bg-muted/60 px-3 py-2 text-[12.5px]">
      {b && <p className="text-muted-foreground">{b.remaining === null ? `Unpaid leave: ${b.used} days used this year.` : `Balance after approval: ${Math.max(0, b.remaining)} of ${b.total} ${b.leaveType.name.toLowerCase()} days (pending included).`}</p>}
      {clashes.length > 0 && (
        <p className="flex items-start gap-1.5 font-medium">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[oklch(0.6_0.14_70)]" />
          {clashes.length} task deadline{clashes.length > 1 ? "s" : ""} in this leave: {clashes.map((t) => t.number).join(", ")}
        </p>
      )}
    </div>
  );
}

export function LeaveRequestCard({ r, showPerson }: { r: LeaveRequest; showPerson?: boolean }) {
  const viewer = useViewer();
  const types = useLeaveTypes();
  const cancel = useCancelLeave();
  const decide = useDecideLeave();
  const askReason = useReason();
  const type = types.data?.find((t) => t.id === r.leaveTypeId);
  const me = viewer?.employee.empId;
  const isMine = r.empId === me;
  const canDecide = !isMine && !!viewer?.can("leave.approve") && currentLeaveApprover(r) === me;
  // Someone above in the reporting line (the CEO / Founder / Owner, or the Director while the CTO decides) only views it.
  const waitingStep = isPendingLeave(r.status) ? r.chain.find((s) => s.state === "waiting") : undefined;
  const viewOnlyStep = !isMine && !canDecide ? waitingStep : undefined;
  const canCancel = isMine && (r.status === "pending_manager" || r.status === "pending_director" || (r.status === "approved" && r.from > isoDay(new Date())));
  const st = LEAVE_STATUS[r.status];

  const act = async (approve: boolean) => {
    const note = approve ? undefined : await askReason({ title: "Reject leave request", description: "The employee sees your reason.", confirmLabel: "Reject", destructive: true });
    if (!approve && !note) return;
    try {
      await decide.mutateAsync({ id: r.id, approve, note: note ?? undefined });
      toast.success(approve ? (r.chain.length > 1 && r.status === "pending_manager" ? "Approved and sent to the Director" : "Leave approved") : "Leave rejected");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
    }
  };

  return (
    <Card className="grid gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1.5">
          {showPerson && <EmpChip empId={r.empId} size="sm" />}
          <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
            <span className="size-2.5 rounded-full" style={{ background: type?.color }} aria-hidden />
            {type?.name ?? "Leave"} leave · {r.days} day{r.days === 1 ? "" : "s"}
          </p>
          <p className="text-[13px]">{leaveDates(r)}</p>
          <p className="text-[12.5px] text-muted-foreground">
            “{r.reason}” · <Mono>{r.number}</Mono> · asked {formatRelative(r.at)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label={leaveStatusLabel(r)} tone={st.tone} />
          {canCancel && (
            <Button
              size="sm"
              variant="ghost"
              loading={cancel.isPending}
              onClick={async () => {
                try {
                  await cancel.mutateAsync(r.id);
                  toast.success("Leave request cancelled");
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Couldn't cancel");
                }
              }}
            >
              <Undo2 /> Cancel
            </Button>
          )}
        </div>
      </div>
      {canDecide && <ApproverContext r={r} />}
      {r.chain.length > 0 && <ApprovalRelay steps={r.chain} />}
      {viewOnlyStep && (
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Eye className="size-3.5 shrink-0" /> View only. The {viewOnlyStep.label} approves this step.
        </p>
      )}
      {canDecide && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => act(false)} disabled={decide.isPending}>
            <X /> Reject
          </Button>
          <Button size="sm" onClick={() => act(true)} loading={decide.isPending}>
            <Check /> Approve
          </Button>
        </div>
      )}
    </Card>
  );
}
