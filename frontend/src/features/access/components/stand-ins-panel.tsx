"use client";
import * as React from "react";
import { toast } from "sonner";
import { ArrowRight, CircleAlert, Plus, UserRoundCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { useReason } from "@/components/shared/dialogs";
import { DataTable } from "@/components/shared/data-table";
import { EmpChip } from "@/components/shared/emp-chip";
import { StatusBadge } from "@/components/shared/chips";
import { EmployeeSelect } from "@/components/shared/pickers";
import { EmptyState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { chainAbove } from "@/lib/auth/scope";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, isoDay } from "@/lib/dates";
import { useCreateStandIn, useEndStandIn, useStandIns } from "../hooks";
import { descendantIds, isManager, standInCandidates, standInStatus, validateStandIn } from "../logic";
import type { StandIn } from "../types";

const STATUS = {
  active: { label: "Active", tone: "success" as const },
  upcoming: { label: "Upcoming", tone: "info" as const },
  ended: { label: "Ended", tone: "outline" as const },
};

export function StandInsPanel() {
  const viewer = useViewer();
  const lookup = useLookup();
  const query = useStandIns();
  const end = useEndStandIn();
  const askReason = useReason();
  const [adding, setAdding] = React.useState(false);
  if (!viewer) return null;
  const me = viewer.employee;
  // Only managers (Director, CTO) approve day-to-day work, so only they have stand-ins. The CEO / Founder / Owner views them.
  const manages = viewer.can("standin.manage") && isManager(me);
  const below = descendantIds(me.empId, lookup.employees);
  const forOthers = viewer.can("roles.manage") && lookup.employees.some((e) => below.includes(e.empId) && isManager(e));
  const canSet = manages && (standInCandidates(me, lookup.employees).length > 0 || forOthers);
  const fallback = chainAbove(me.empId)[0];
  const canEnd = (s: StandIn) => manages && (s.managerEmpId === me.empId || (viewer.can("roles.manage") && below.includes(s.managerEmpId)));
  const emptyText = !manages
    ? "No stand-ins set. View only: the Director and the CTO set their own stand-ins."
    : me.role === "director"
      ? "Nobody stands in for you: the CEO / Founder / Owner approves nothing, so your approvals wait until you are back."
      : fallback
        ? `No stand-ins set. When you're on leave your approvals go to ${fallback.name} (${fallback.designation}).`
        : "No stand-ins set.";

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-[13px] text-muted-foreground">
          When a manager (Director or CTO) is on leave, their approvals go to a named stand-in for set dates. A stand-in is another manager at the same level or higher. Without one, the CTO&apos;s approvals go to the Director. Nobody stands in for the Director, because the CEO / Founder / Owner approves nothing.
          {!manages && <span className="mt-1 block font-medium text-foreground">View only. The Director and the CTO set their own stand-ins.</span>}
        </p>
        {canSet && (
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add stand-in
          </Button>
        )}
      </div>

      <DataTable<StandIn>
        rows={query.data}
        loading={query.isPending}
        rowKey={(s) => s.id}
        initialSort={{ key: "from", dir: "desc" }}
        empty={
          <EmptyState
            icon={<UserRoundCheck />}
            title="No stand-ins set"
            description={emptyText}
            action={canSet && <Button variant="outline" onClick={() => setAdding(true)}>Add stand-in</Button>}
          />
        }
        columns={[
          { key: "manager", header: "Manager", cell: (s) => <EmpChip empId={s.managerEmpId} size="sm" />, sortValue: (s) => s.managerEmpId },
          { key: "standin", header: "Stand-in", cell: (s) => <EmpChip empId={s.standInEmpId} size="sm" /> },
          {
            key: "from",
            header: "Dates",
            cell: (s) => (
              <span className="whitespace-nowrap tabular">
                {formatDate(s.from)} <ArrowRight className="inline size-3 text-muted-foreground" /> {formatDate(s.to)}
              </span>
            ),
            sortValue: (s) => s.from,
          },
          { key: "status", header: "Status", cell: (s) => <StatusBadge {...STATUS[standInStatus(s)]} /> },
          { key: "reason", header: "Reason", cell: (s) => <span className="text-muted-foreground">{s.endReason ? `Ended early: ${s.endReason}` : (s.reason ?? "—")}</span>, hideOnMobile: true },
          {
            key: "actions",
            header: "",
            align: "right",
            cell: (s) =>
              standInStatus(s) !== "ended" && canEnd(s) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const reason = await askReason({ title: "End this stand-in early?", description: "The record is kept in history. Approvals go back to the manager.", confirmLabel: "End stand-in", destructive: true });
                    if (!reason) return;
                    await end.mutateAsync({ id: s.id, reason });
                    toast.success("Stand-in ended");
                  }}
                >
                  End early
                </Button>
              ) : null,
          },
        ]}
      />
      {adding && <AddStandInDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddStandInDialog({ onClose }: { onClose: () => void }) {
  const viewer = useViewer()!;
  const lookup = useLookup();
  const create = useCreateStandIn();
  const me = viewer.employee;
  // With roles.manage (the Director) you can also set one for a manager below you (the CTO).
  // Nobody can stand in for the Director (the CEO / Founder / Owner approves nothing), so the Director only sets them for others.
  const below = descendantIds(me.empId, lookup.employees);
  const forOthers = viewer.can("roles.manage") && lookup.employees.some((e) => below.includes(e.empId) && isManager(e));
  const selfOk = standInCandidates(me, lookup.employees).length > 0;
  const [manager, setManager] = React.useState(selfOk ? me.empId : "");
  const [standIn, setStandIn] = React.useState("");
  const [from, setFrom] = React.useState(isoDay(new Date()));
  const [to, setTo] = React.useState("");
  const [reason, setReason] = React.useState("");
  const managerEmp = lookup.employee(manager);
  const error = standIn && to ? validateStandIn({ managerEmpId: manager, standInEmpId: standIn, from, to }, lookup.employees) : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a stand-in</DialogTitle>
          <DialogDescription>Their approvals go to the stand-in for these dates only.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Manager on leave" htmlFor="si-manager">
            {forOthers ? (
              <EmployeeSelect
                id="si-manager"
                value={manager}
                onChange={(v) => { setManager(v); setStandIn(""); }}
                filter={(e) => isManager(e) && ((below.includes(e.empId) && e.status !== "left") || (e.empId === me.empId && selfOk))}
              />
            ) : (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                <EmpChip empId={manager} link={false} />
              </div>
            )}
          </Field>
          <Field label="Stand-in" htmlFor="si-person" required hint="Another manager at the same level or higher (for the CTO: the Director).">
            <EmployeeSelect id="si-person" value={standIn} onChange={setStandIn} filter={(e) => standInCandidates(managerEmp, [e]).length > 0} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From" htmlFor="si-from" required>
              <Input id="si-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To" htmlFor="si-to" required>
              <Input id="si-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          <Field label="Reason (optional)" htmlFor="si-reason">
            <Textarea id="si-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Annual leave" />
          </Field>
          {error && (
            <p role="alert" className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px]">
              <CircleAlert className="size-4 text-danger" /> {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!standIn || !to || !!error}
            loading={create.isPending}
            onClick={async () => {
              try {
                await create.mutateAsync({
                  managerEmpId: manager,
                  standInEmpId: standIn,
                  from: new Date(`${from}T00:00`).toISOString(),
                  to: new Date(`${to}T23:59`).toISOString(),
                  reason: reason.trim() || undefined,
                });
                toast.success("Stand-in added", { description: `${lookup.employee(standIn)?.name} approves for ${managerEmp?.name} from ${formatDate(`${from}T00:00`)}.` });
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Couldn't add the stand-in.");
              }
            }}
          >
            Add stand-in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
