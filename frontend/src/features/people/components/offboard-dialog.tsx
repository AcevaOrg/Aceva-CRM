"use client";
import * as React from "react";
import { toast } from "sonner";
import { Archive, CalendarX, KeyRound, ListTodo, LogOut, Contact, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { useLookup } from "@/hooks/use-directory";
import { formatDate, isoDay } from "@/lib/dates";
import type { Employee } from "@/types";
import { useOffboard, useOffboardPreview } from "../hooks";

/** "Set last working day" (plan §7 Leaving): preview what happens on that day, then confirm. */
export function OffboardDialog({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const lookup = useLookup();
  const preview = useOffboardPreview(employee.empId, true);
  const offboard = useOffboard();
  const twoWeeks = new Date();
  twoWeeks.setDate(twoWeeks.getDate() + 14);
  const [date, setDate] = React.useState(isoDay(twoWeeks));
  const [reason, setReason] = React.useState("");
  const manager = lookup.employee(employee.reportsTo);
  const p = preview.data;
  const when = date ? formatDate(`${date}T09:00`) : "that day";

  const steps = p
    ? [
        { icon: KeyRound, text: "Login is disabled." },
        { icon: LogOut, text: `All sessions end${p.activeSessions ? ` (${p.activeSessions} active now)` : ""}.` },
        { icon: ListTodo, text: p.openTasks ? `${p.openTasks} open task${p.openTasks === 1 ? "" : "s"} move to ${manager?.name ?? "the manager"}.` : "No open tasks to move." },
        ...(p.directReports ? [{ icon: ListTodo, text: `${p.directReports} direct report${p.directReports === 1 ? "" : "s"} need a new manager (the Director changes it in Org and access).` }] : []),
        ...(p.isSales ? [{ icon: Contact, text: "Their leads and deals move to the Director (sales manager)." }] : []),
        { icon: Wallet, text: "Finance adds the final salary to the next payroll run; the Director approves it." },
        { icon: Archive, text: "The record is kept, never deleted." },
      ]
    : [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <span className="mb-1 grid size-10 place-content-center rounded-xl bg-warning/15 text-[oklch(0.55_0.13_70)]">
            <CalendarX className="size-5" />
          </span>
          <DialogTitle>Set last working day for {employee.name}</DialogTitle>
          <DialogDescription>Until that day they stay active and show as “On notice”.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Last working day" htmlFor="ob-date" required>
            <Input id="ob-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Reason" htmlFor="ob-reason" required hint="Saved in the profile history.">
            <Textarea id="ob-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Resigned to pursue a master's degree" />
          </Field>
          <div className="rounded-xl border border-border bg-muted/40 p-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">On {when}, the system will</p>
            {preview.isPending ? (
              <div className="grid gap-2">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-4 w-3/4" />)}
              </div>
            ) : (
              <ul className="grid gap-2 text-[13px]">
                {steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <s.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> {s.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!date || reason.trim().length < 3}
            loading={offboard.isPending}
            onClick={async () => {
              try {
                await offboard.mutateAsync({ empId: employee.empId, input: { lastWorkingDay: new Date(`${date}T18:00`).toISOString(), reason: reason.trim() } });
                toast.success(`Last working day set: ${when}`, { description: `${employee.name} is now on notice. Everything above happens automatically on that day.` });
                onClose();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Couldn't save.");
              }
            }}
          >
            Set last working day
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
