"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRight, MoveRight, ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmpChip } from "@/components/shared/emp-chip";
import { LevelMark } from "@/components/shared/level-mark";
import { DetailList, EmployeeSelect } from "@/components/shared/pickers";
import { useLookup } from "@/hooks/use-directory";
import { DUTY_LABEL, ROLE_LABEL } from "@/lib/auth/permissions";
import { useCan } from "@/lib/auth/viewer";
import { formatDate } from "@/lib/dates";
import { useMoveEmployee } from "../hooks";
import { descendantIds } from "../logic";

/** Side sheet for one org chart node, with "Move under…" for Owner/CEO (spec §9.1). */
export function OrgNodeSheet({ empId, onClose }: { empId: string | null; onClose: () => void }) {
  // Keyed by person so the move form resets when another node is opened.
  return <NodeSheet key={empId ?? "none"} empId={empId} onClose={onClose} />;
}

function NodeSheet({ empId, onClose }: { empId: string | null; onClose: () => void }) {
  const lookup = useLookup();
  const canManage = useCan("org.manage");
  const move = useMoveEmployee();
  const [moving, setMoving] = React.useState(false);
  const [boss, setBoss] = React.useState("");
  const [reason, setReason] = React.useState("");

  const e = lookup.employee(empId);

  if (!e) return <Sheet open={false} />;

  const reports = lookup.employees.filter((x) => x.reportsTo === e.empId && x.status !== "left");
  const below = descendantIds(e.empId, lookup.employees);
  const dept = lookup.department(e.departmentId);
  const office = lookup.office(e.officeId);
  const canSave = !!boss && reason.trim().length >= 3 && boss !== e.reportsTo;

  const save = async () => {
    try {
      await move.mutateAsync({ empId: e.empId, reportsTo: boss, reason: reason.trim() });
      toast.success(`${e.name} now reports to ${lookup.employee(boss)?.name}`, { description: "Access updates in every module at once. The change is in the audit log." });
      setMoving(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't move this person.");
    }
  };

  return (
    <Sheet open={!!empId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="md">
        <SheetHeader>
          <div className="flex items-center gap-3">
            <Avatar name={e.name} hue={e.avatarHue} size={48} />
            <div className="min-w-0">
              <SheetTitle className="truncate">{e.name}</SheetTitle>
              <SheetDescription className="truncate">
                {e.designation} · <span className="font-mono">{e.empId}</span>
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <SheetBody className="grid content-start gap-6">
          <DetailList
            columns={2}
            items={[
              ["Level", <LevelMark key="l" level={e.level} showLabel />],
              ["Role", ROLE_LABEL[e.role]],
              ["Duties", e.duties.length ? <span className="flex flex-wrap gap-1">{e.duties.map((d) => <Badge key={d} tone="primary">{DUTY_LABEL[d]}</Badge>)}</span> : "None"],
              ["Department", dept?.name],
              ["Office", office?.name],
              ["Joined", formatDate(e.joiningDate)],
            ]}
          />
          <section>
            <p className="mb-2 text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">Reports to</p>
            {e.reportsTo ? <EmpChip empId={e.reportsTo} /> : <p className="text-[13px] text-muted-foreground">Nobody. Top of the company.</p>}
          </section>
          <section>
            <p className="mb-2 text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">
              Direct reports · {reports.length}
              {below.length > reports.length && <span className="normal-case tracking-normal"> ({below.length} in the whole branch)</span>}
            </p>
            {reports.length ? (
              <ul className="grid gap-2">
                {reports.map((r) => (
                  <li key={r.empId}>
                    <EmpChip empId={r.empId} subtitle={r.designation} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">No one reports to {e.name.split(" ")[0]}.</p>
            )}
          </section>

          {canManage && e.reportsTo && (
            <section className="rounded-xl border border-border bg-muted/40 p-4">
              {!moving ? (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-medium">Change reporting line</p>
                    <p className="text-[12px] text-muted-foreground">Only the Owner or CEO can do this. A reason is required.</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setMoving(true)}>
                    <MoveRight /> Move under…
                  </Button>
                </div>
              ) : (
                <div className="grid gap-3">
                  <Field label="New manager" htmlFor="move-boss" required>
                    <EmployeeSelect
                      id="move-boss"
                      value={boss}
                      onChange={setBoss}
                      filter={(x) => x.empId !== e.empId && !below.includes(x.empId) && x.level < e.level}
                      placeholder="Choose who they'll report to"
                    />
                  </Field>
                  {boss && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-card p-3 text-[12.5px]">
                      <span className="text-muted-foreground">Preview:</span>
                      <span className="font-medium">{e.name}</span>
                      {below.length > 0 && <span className="text-muted-foreground">and {below.length} people below</span>}
                      <ArrowRight className="size-3.5 text-muted-foreground" />
                      <span className="font-medium">{lookup.employee(boss)?.name}</span>
                    </div>
                  )}
                  <Field label="Reason" htmlFor="move-reason" required hint="Saved with the change in the audit log.">
                    <Textarea id="move-reason" value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="For example: joins the new mobile team" />
                  </Field>
                </div>
              )}
            </section>
          )}

          <Link href={`/people/${e.empId}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
            Open full profile <ArrowRight className="size-3.5" />
          </Link>
        </SheetBody>
        {moving && (
          <SheetFooter>
            <span className="mr-auto flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <ScrollText className="size-3.5" /> Logged
            </span>
            <Button variant="outline" onClick={() => setMoving(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!canSave} loading={move.isPending}>
              Save new reporting line
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
