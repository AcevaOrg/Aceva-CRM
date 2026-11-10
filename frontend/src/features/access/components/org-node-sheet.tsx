"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRight, BadgePlus, MoveRight, ScrollText, ShieldPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useReason } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { LevelMark } from "@/components/shared/level-mark";
import { DetailList, EmployeeSelect } from "@/components/shared/pickers";
import { useLookup } from "@/hooks/use-directory";
import { DUTY_LABEL, LEVEL_LABEL, ROLE_LABEL } from "@/lib/auth/permissions";
import { useCan, useViewer } from "@/lib/auth/viewer";
import { formatDate } from "@/lib/dates";
import type { Duty, Level } from "@/types";
import { useAssignDuty, useChangeLevel, useEndDuty, useMoveEmployee, useOrgTree } from "../hooks";
import { canReportTo, descendantIds, REPORTS_TO_HINT } from "../logic";

const DUTIES: Duty[] = ["finance", "hr", "sales_manager"];

/**
 * Side sheet for one org chart node (spec §9.1). The Owner and CEO (org.manage) can move someone under a different
 * manager or change their level; the Director (duty.assign) gives extra duties. The server checks every one of these.
 */
export function OrgNodeSheet({ empId, onClose }: { empId: string | null; onClose: () => void }) {
  // Keyed by person so the forms reset when another node is opened.
  return <NodeSheet key={empId ?? "none"} empId={empId} onClose={onClose} />;
}

function NodeSheet({ empId, onClose }: { empId: string | null; onClose: () => void }) {
  const lookup = useLookup();
  const tree = useOrgTree();
  const canManage = useCan("org.manage");
  const canDuties = useCan("roles.manage");
  const viewer = useViewer();
  const move = useMoveEmployee();
  const changeLevel = useChangeLevel();
  const assignDuty = useAssignDuty();
  const endDuty = useEndDuty();
  const askReason = useReason();
  const [mode, setMode] = React.useState<null | "move" | "level">(null);
  const [boss, setBoss] = React.useState("");
  const [level, setLevel] = React.useState("");
  const [reason, setReason] = React.useState("");

  const nodes = tree.data ?? [];
  const e = nodes.find((n) => n.empId === empId);

  if (!e) return <Sheet open={false} />;

  const me = viewer?.employee;
  const reports = nodes.filter((x) => x.reportsTo === e.empId);
  const below = descendantIds(e.empId, nodes);
  const dept = lookup.department(e.departmentId);
  const office = lookup.office(e.officeId);
  const joined = lookup.employee(e.empId)?.joiningDate;
  // Only people BELOW you can be changed, never yourself (the server enforces the same).
  const isBelowMe = !!me && me.empId !== e.empId && descendantIds(me.empId, nodes).includes(e.empId);
  const canMove = canManage && isBelowMe && !!e.reportsTo;
  const levelChoices = ([2, 3, 4, 5] as Level[]).filter((l) => me && l > me.level && l !== e.level);
  const canSave = reason.trim().length >= 5 && (mode === "move" ? !!boss && boss !== e.reportsTo : mode === "level" ? !!level : false);
  const busy = move.isPending || changeLevel.isPending;

  const close = () => {
    setMode(null);
    setBoss("");
    setLevel("");
    setReason("");
  };

  const save = async () => {
    try {
      if (mode === "move") {
        await move.mutateAsync({ empId: e.empId, reportsTo: boss, reason: reason.trim() });
        toast.success(`${e.name} now reports to ${lookup.employee(boss)?.name ?? boss}`, { description: "Access updates in every module at once. The change is in the audit log." });
      } else if (mode === "level") {
        await changeLevel.mutateAsync({ empId: e.empId, level: Number(level) as Level, reason: reason.trim() });
        toast.success(`${e.name} is now ${LEVEL_LABEL[Number(level)]} (Level ${level})`, { description: "Their permissions change on their next request. The change is in the audit log." });
      }
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save this change.");
    }
  };

  const giveDuty = async (duty: Duty) => {
    const why = await askReason({ title: `Give ${e.name.split(" ")[0]} the ${DUTY_LABEL[duty]}?`, description: "The duty adds permissions on top of their role. A reason is required and saved in the audit log.", confirmLabel: "Give duty" });
    if (!why) return;
    try {
      await assignDuty.mutateAsync({ empId: e.empId, duty, reason: why });
      toast.success(`${DUTY_LABEL[duty]} given to ${e.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't give the duty.");
    }
  };

  const removeDuty = async (duty: Duty) => {
    const why = await askReason({ title: `End the ${DUTY_LABEL[duty]} for ${e.name}?`, description: "The record is kept in history. A reason is required.", confirmLabel: "End duty", destructive: true });
    if (!why) return;
    try {
      await endDuty.mutateAsync({ empId: e.empId, duty, reason: why });
      toast.success(`${DUTY_LABEL[duty]} ended for ${e.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't end the duty.");
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
              ["Joined", joined ? formatDate(joined) : "—"],
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

          {canDuties && isBelowMe && (
            <section className="rounded-xl border border-border bg-muted/40 p-4">
              <p className="mb-1 text-[13px] font-medium">Extra duties</p>
              <p className="mb-3 text-[12px] text-muted-foreground">Only the Director gives or ends duties. Each change is logged with its reason.</p>
              <div className="flex flex-wrap gap-2">
                {DUTIES.map((d) =>
                  e.duties.includes(d) ? (
                    <Button key={d} size="sm" variant="outline" onClick={() => removeDuty(d)} loading={endDuty.isPending}>
                      <ShieldPlus /> End {DUTY_LABEL[d]}
                    </Button>
                  ) : (
                    <Button key={d} size="sm" variant="outline" onClick={() => giveDuty(d)} loading={assignDuty.isPending}>
                      <BadgePlus /> Give {DUTY_LABEL[d]}
                    </Button>
                  ),
                )}
              </div>
            </section>
          )}

          {!canManage && e.reportsTo && (
            <p className="rounded-xl border border-dashed border-border px-4 py-3 text-[12.5px] text-muted-foreground">View only. The Owner and the CEO change levels and reporting lines.</p>
          )}
          {canManage && me?.empId === e.empId && (
            <p className="rounded-xl border border-dashed border-border px-4 py-3 text-[12.5px] text-muted-foreground">Nobody changes their own level or reporting line.</p>
          )}
          {canManage && me?.empId !== e.empId && !isBelowMe && (
            <p className="rounded-xl border border-dashed border-border px-4 py-3 text-[12.5px] text-muted-foreground">You can only change people below you in the reporting line.</p>
          )}
          {canMove && (
            <section className="rounded-xl border border-border bg-muted/40 p-4">
              {mode === null ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-medium">Change level or reporting line</p>
                    <p className="text-[12px] text-muted-foreground">Only the Owner and the CEO can do this. A reason is required.</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setMode("level")} disabled={!levelChoices.length}>
                      Change level
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setMode("move")}>
                      <MoveRight /> Move under…
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid gap-3">
                  {mode === "move" ? (
                    <>
                      <Field label="New manager" htmlFor="move-boss" required hint={`${REPORTS_TO_HINT[e.level]} The server checks the rules.`}>
                        <EmployeeSelect
                          id="move-boss"
                          value={boss}
                          onChange={setBoss}
                          filter={(x) => x.empId !== e.empId && !below.includes(x.empId) && canReportTo(e, x) && !!me && (x.empId === me.empId || descendantIds(me.empId, nodes).includes(x.empId))}
                          placeholder="Choose who they'll report to"
                        />
                      </Field>
                      {boss && (
                        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-card p-3 text-[12.5px]">
                          <span className="text-muted-foreground">Preview:</span>
                          <span className="font-medium">{e.name}</span>
                          {below.length > 0 && <span className="text-muted-foreground">and {below.length} people below</span>}
                          <ArrowRight className="size-3.5 text-muted-foreground" />
                          <span className="font-medium">{lookup.employee(boss)?.name ?? boss}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <Field label="New level" htmlFor="level-new" required hint="You can't give a level at or above your own. The server checks the reporting lines stay valid.">
                      <NativeSelect id="level-new" value={level} onChange={(ev) => setLevel(ev.target.value)}>
                        <option value="">Choose a level</option>
                        {levelChoices.map((l) => (
                          <option key={l} value={l}>
                            Level {l} · {LEVEL_LABEL[l]}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                  )}
                  <Field label="Reason" htmlFor="change-reason" required hint="At least 5 characters. Saved with the change in the audit log.">
                    <Textarea id="change-reason" value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="For example: promoted to team lead" />
                  </Field>
                </div>
              )}
            </section>
          )}

          <Link href={`/people/${e.empId}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
            Open full profile <ArrowRight className="size-3.5" />
          </Link>
        </SheetBody>
        {mode !== null && (
          <SheetFooter>
            <span className="mr-auto flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <ScrollText className="size-3.5" /> Logged
            </span>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!canSave} loading={busy}>
              {mode === "move" ? "Save new reporting line" : "Save new level"}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
