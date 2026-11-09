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
import { standInStatus, validateStandIn } from "../logic";
import type { StandIn } from "../types";

const STATUS = {
  active: { label: "Active", tone: "success" as const },
  upcoming: { label: "Upcoming", tone: "info" as const },
  ended: { label: "Ended", tone: "outline" as const },
};

export function StandInsPanel() {
  const viewer = useViewer();
  const query = useStandIns();
  const end = useEndStandIn();
  const askReason = useReason();
  const [adding, setAdding] = React.useState(false);
  if (!viewer) return null;
  const me = viewer.employee;
  const canSet = me.level <= 4;
  const fallback = chainAbove(me.empId)[0];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-[13px] text-muted-foreground">
          When a manager is on leave, their approvals go to a named stand-in for set dates. Without a stand-in they go to the next level up. A stand-in must be at the same level or higher.
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
            description={fallback ? `When you're on leave your approvals go to ${fallback.name} (${fallback.designation}).` : "When you're on leave, approvals go to the next level up."}
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
              standInStatus(s) !== "ended" && (s.managerEmpId === me.empId || viewer.can("roles.manage")) ? (
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
  const forOthers = viewer.can("roles.manage");
  const [manager, setManager] = React.useState(viewer.employee.empId);
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
              <EmployeeSelect id="si-manager" value={manager} onChange={(v) => { setManager(v); setStandIn(""); }} filter={(e) => e.level <= 4} />
            ) : (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                <EmpChip empId={manager} link={false} />
              </div>
            )}
          </Field>
          <Field label="Stand-in" htmlFor="si-person" required hint="Same level or higher than the manager.">
            <EmployeeSelect id="si-person" value={standIn} onChange={setStandIn} filter={(e) => e.empId !== manager && (!managerEmp || e.level <= managerEmp.level)} />
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
