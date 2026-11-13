"use client";
/**
 * Settings sections for Module 7 in LIVE mode (m7): working days and hours, the holiday calendar and leave types, read from and
 * saved to the server. Every change asks for a reason (kept in the audit log). History is never rewritten: a schedule change
 * is a new schedule from a chosen day, holidays and leave types are archived, not deleted. Only the Director (settings.manage)
 * edits; everyone else sees the values read-only.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, Plus, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Switch } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/misc";
import { useReason } from "@/components/shared/dialogs";
import { ErrorState } from "@/components/shared/states";
import { useCan } from "@/lib/auth/viewer";
import { formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { WorkScheduleResponse } from "@aceva/contracts";
import { liveAttendanceSettingsApi as api, pkToday } from "@/features/attendance/live-api";
import { NumberInput } from "./settings-kit";

const DAYS = [
  { iso: 1, label: "Mon" }, { iso: 2, label: "Tue" }, { iso: 3, label: "Wed" }, { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" }, { iso: 6, label: "Sat" }, { iso: 7, label: "Sun" },
];

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 border-b border-dashed border-border pb-4 last:border-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:items-center sm:gap-6">
      <div>
        <Label>{label}</Label>
        {hint && <p className="mt-1 text-[12px] text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function useSaver() {
  const qc = useQueryClient();
  const askReason = useReason();
  return async <T,>(title: string, run: (reason: string) => Promise<T>) => {
    const reason = await askReason({ title, description: "Every settings change is saved in the audit log with your reason.", confirmLabel: "Save change" });
    if (!reason) return false;
    try {
      await run(reason);
      toast.success("Saved", { description: "Logged in the audit trail." });
      await qc.invalidateQueries({ queryKey: ["m7-settings"] });
      await qc.invalidateQueries({ queryKey: ["attendance"] });
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };
}

/* ---------------- Working days and hours ---------------- */

export function LiveScheduleSection() {
  const q = useQuery({ queryKey: ["m7-settings", "schedule"], queryFn: api.schedule });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96 rounded-xl" />;
  // Remount the form when the schedule in force changes, so the draft starts from it.
  return <ScheduleForm key={`${q.data.current?.id ?? "none"}:${q.data.upcoming.length}`} data={q.data} />;
}

function ScheduleForm({ data }: { data: WorkScheduleResponse }) {
  const can = useCan("settings.manage");
  const nets = useQuery({ queryKey: ["m7-settings", "networks"], queryFn: api.officeNetworks, enabled: can });
  const save = useSaver();
  const current = data.current;
  const [draft, setDraft] = React.useState(() => ({
    effectiveFrom: pkToday(),
    start: current?.start ?? "09:00",
    end: current?.end ?? "18:00",
    graceMinutes: current?.graceMinutes ?? 15,
    workingWeekdays: current?.workingWeekdays ?? [1, 2, 3, 4, 5],
    officeOnlyCheckIn: current?.officeOnlyCheckIn ?? false,
  }));
  const [net, setNet] = React.useState({ officeCode: "off-khi", cidr: "", label: "" });
  const q = { data };
  const set = (patch: Partial<typeof draft>) => setDraft({ ...draft, ...patch });

  return (
    <div className="grid gap-5">
      <Card>
        <CardContent className="grid gap-5 pt-5">
          <Row label="In force today" hint="Past days keep the schedule they had; a change starts on a day you choose.">
            {current ? (
              <p className="text-[13px]">
                {current.workingWeekdays.map((d) => DAYS[d - 1].label).join(", ")} · {current.start}–{current.end} · {current.graceMinutes} min grace (on time until{" "}
                <span className="font-mono">{current.graceEnd}</span>) · since {formatDate(current.effectiveFrom)}
                {current.officeOnlyCheckIn && <Badge tone="warning" className="ml-2">Office-only check-in</Badge>}
              </p>
            ) : (
              <p className="text-[13px] text-muted-foreground">No schedule yet.</p>
            )}
          </Row>
          {q.data.upcoming.length > 0 && (
            <Row label="Coming up">
              <ul className="text-[13px]">
                {q.data.upcoming.map((s) => (
                  <li key={s.id}>
                    From {formatDate(s.effectiveFrom)}: {s.workingWeekdays.map((d) => DAYS[d - 1].label).join(", ")} · {s.start}–{s.end} · {s.graceMinutes} min grace
                  </li>
                ))}
              </ul>
            </Row>
          )}
          <Row label="Working days" hint="Tasks, leave and payroll count only these days.">
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((day) => {
                const on = draft.workingWeekdays.includes(day.iso);
                return (
                  <button
                    key={day.iso}
                    type="button"
                    disabled={!can}
                    aria-pressed={on}
                    onClick={() => set({ workingWeekdays: on ? draft.workingWeekdays.filter((x) => x !== day.iso) : [...draft.workingWeekdays, day.iso].sort((a, b) => a - b) })}
                    className={cn("h-9 w-12 rounded-lg border text-[12.5px] font-medium transition disabled:cursor-not-allowed", on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:bg-muted")}
                  >
                    {day.label}
                  </button>
                );
              })}
            </div>
          </Row>
          <Row label="Working hours (Pakistan time)" hint="Check-in after start time plus the grace period is marked late. At the end of hours a day without check-out is closed as “missed check-out”.">
            <div className="grid grid-cols-3 gap-2">
              <Input type="time" aria-label="Start time" value={draft.start} disabled={!can} onChange={(e) => set({ start: e.target.value })} />
              <Input type="time" aria-label="End time" value={draft.end} disabled={!can} onChange={(e) => set({ end: e.target.value })} />
              <NumberInput value={draft.graceMinutes} onChange={(n) => set({ graceMinutes: n })} suffix="min grace" disabled={!can} />
            </div>
          </Row>
          <Row label="Office-only check-in" hint="Office staff can check in only from their office network. An office without networks (Remote) is not restricted.">
            <Switch checked={draft.officeOnlyCheckIn} disabled={!can} onCheckedChange={(v) => set({ officeOnlyCheckIn: v })} aria-label="Office-only check-in" />
          </Row>
          <Row label="Starts on" hint="Today or a later day.">
            <Input type="date" aria-label="Starts on" min={pkToday()} value={draft.effectiveFrom} disabled={!can} onChange={(e) => set({ effectiveFrom: e.target.value })} className="w-44" />
          </Row>
        </CardContent>
        {can && (
          <CardFooter className="justify-end">
            <Button
              disabled={!draft.workingWeekdays.length}
              onClick={() => void save("Save working days and hours", (reason) => api.newSchedule({ ...draft, reason }))}
            >
              <Save /> Save as a new schedule
            </Button>
          </CardFooter>
        )}
      </Card>
      {can && (
        <Card>
          <CardContent className="grid gap-4 pt-5">
            <Label>Office networks</Label>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border text-[13px]">
              {(nets.data ?? []).filter((n) => !n.archived).map((n) => (
                <li key={n.id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span>
                    {n.officeName} · <span className="font-mono">{n.cidr}</span> {n.label && <span className="text-muted-foreground">· {n.label}</span>}
                  </span>
                  <Button size="icon-sm" variant="ghost" aria-label={`Archive ${n.cidr}`} onClick={() => void save("Archive office network", (reason) => api.archiveOfficeNetwork(n.id, reason))}>
                    <Archive />
                  </Button>
                </li>
              ))}
              {!(nets.data ?? []).some((n) => !n.archived) && <li className="px-4 py-2 text-muted-foreground">No office networks: nobody is restricted.</li>}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <Input aria-label="Office code" value={net.officeCode} onChange={(e) => setNet({ ...net, officeCode: e.target.value })} className="w-32" placeholder="off-khi" />
              <Input aria-label="Address or range" value={net.cidr} onChange={(e) => setNet({ ...net, cidr: e.target.value })} className="w-48 font-mono" placeholder="203.0.113.0/24" />
              <Input aria-label="Label" value={net.label} onChange={(e) => setNet({ ...net, label: e.target.value })} className="flex-1" placeholder="Karachi fibre line" />
              <Button
                variant="outline"
                disabled={!net.cidr}
                onClick={() => void save("Add office network", (reason) => api.addOfficeNetwork({ officeCode: net.officeCode, cidr: net.cidr, label: net.label || undefined, reason })).then((ok) => ok && setNet({ ...net, cidr: "", label: "" }))}
              >
                <Plus /> Add
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ---------------- Holidays ---------------- */

export function LiveHolidaysSection() {
  const can = useCan("settings.manage");
  const year = Number(pkToday().slice(0, 4));
  const q = useQuery({ queryKey: ["m7-settings", "holidays", year], queryFn: async () => [...(await api.holidays(year)), ...(await api.holidays(year + 1))] });
  const save = useSaver();
  const [date, setDate] = React.useState("");
  const [name, setName] = React.useState("");
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96 rounded-xl" />;
  const active = q.data.filter((h) => !h.archived);
  const today = pkToday();
  return (
    <Card>
      <CardContent className="grid gap-4 pt-5">
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {active.map((h) => (
            <li key={h.id} className={cn("flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]", h.date < today && "text-muted-foreground")}>
              <span className="flex items-center gap-3">
                <span className="w-28 font-mono tabular">{formatDate(h.date)}</span>
                <span>{h.name}</span>
              </span>
              {can && (
                <Button size="icon-sm" variant="ghost" aria-label={`Archive ${h.name}`} onClick={() => void save(`Archive ${h.name}`, (reason) => api.archiveHoliday(h.id, reason))}>
                  <Archive />
                </Button>
              )}
            </li>
          ))}
          {!active.length && <li className="px-4 py-2.5 text-[13px] text-muted-foreground">No holidays yet.</li>}
        </ul>
        {can && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="live-hol-date">Date</Label>
              <Input id="live-hol-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
            </div>
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="live-hol-name">Name</Label>
              <Input id="live-hol-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Company retreat" />
            </div>
            <Button
              variant="outline"
              disabled={!date || name.trim().length < 2}
              onClick={() =>
                void save("Add holiday", (reason) => api.addHoliday({ date, name: name.trim(), reason })).then((ok) => {
                  if (ok) {
                    setDate("");
                    setName("");
                  }
                })
              }
            >
              <Plus /> Add holiday
            </Button>
          </div>
        )}
        <p className="text-[12px] text-muted-foreground">Holidays are archived, never deleted. A month locked for payroll cannot change.</p>
      </CardContent>
    </Card>
  );
}

/* ---------------- Leave types ---------------- */

export function LiveLeaveTypesSection() {
  const can = useCan("settings.manage");
  const q = useQuery({ queryKey: ["m7-settings", "leave-types"], queryFn: api.leaveTypes });
  const save = useSaver();
  const [edits, setEdits] = React.useState<Record<string, { name?: string; yearlyDays?: number | null; paid?: boolean }>>({});
  const [fresh, setFresh] = React.useState({ key: "", name: "", yearlyDays: 0, limited: true, paid: true });
  const update = useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => api.updateLeaveType(id, { ...edits[id], reason }) });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96 rounded-xl" />;
  const types = q.data.filter((t) => !t.archived);
  return (
    <Card>
      <CardContent className="grid gap-4 pt-5">
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[560px] text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2">Leave type</th>
                <th className="px-3 py-2">Days a year</th>
                <th className="px-3 py-2">Paid</th>
                <th className="w-28" />
              </tr>
            </thead>
            <tbody>
              {types.map((t) => {
                const e = edits[t.id] ?? {};
                const days = e.yearlyDays !== undefined ? e.yearlyDays : t.yearlyDays;
                const dirty = Object.keys(e).length > 0;
                const patch = (p: typeof e) => setEdits({ ...edits, [t.id]: { ...e, ...p } });
                return (
                  <tr key={t.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      <Input aria-label="Leave type name" value={e.name ?? t.name} disabled={!can} onChange={(ev) => patch({ name: ev.target.value })} />
                    </td>
                    <td className="w-44 px-3 py-2">
                      {days === null ? (
                        <span className="text-muted-foreground">No limit</span>
                      ) : (
                        <NumberInput value={days} step={0.5} onChange={(n) => patch({ yearlyDays: n })} suffix="days" disabled={!can} />
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Switch checked={e.paid ?? t.paid} disabled={!can} onCheckedChange={(v) => patch({ paid: v })} aria-label={`${t.name} is paid`} />
                    </td>
                    <td className="px-2">
                      {can && (
                        <span className="flex gap-1">
                          <Button size="icon-sm" variant="ghost" aria-label={`Save ${t.name}`} disabled={!dirty} onClick={() => void save(`Change ${t.name}`, (reason) => update.mutateAsync({ id: t.id, reason })).then((ok) => ok && setEdits({ ...edits, [t.id]: {} }))}>
                            <Save />
                          </Button>
                          <Button size="icon-sm" variant="ghost" aria-label={`Archive ${t.name}`} onClick={() => void save(`Archive ${t.name}`, (reason) => api.archiveLeaveType(t.id, reason))}>
                            <Archive />
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {can && (
          <div className="flex flex-wrap items-end gap-2">
            <Input aria-label="Key" value={fresh.key} onChange={(e) => setFresh({ ...fresh, key: e.target.value.toLowerCase() })} className="w-32 font-mono" placeholder="maternity" />
            <Input aria-label="Name" value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} className="flex-1" placeholder="Maternity" />
            <NumberInput value={fresh.yearlyDays} step={0.5} onChange={(n) => setFresh({ ...fresh, yearlyDays: n })} suffix="days" disabled={!fresh.limited} className="w-36" />
            <label className="flex items-center gap-2 text-[12.5px]">
              <Switch checked={!fresh.limited} onCheckedChange={(v) => setFresh({ ...fresh, limited: !v })} aria-label="No yearly limit" /> No limit
            </label>
            <label className="flex items-center gap-2 text-[12.5px]">
              <Switch checked={fresh.paid} onCheckedChange={(v) => setFresh({ ...fresh, paid: v })} aria-label="Paid" /> Paid
            </label>
            <Button
              variant="outline"
              disabled={fresh.key.length < 2 || fresh.name.trim().length < 2}
              onClick={() =>
                void save("Add leave type", (reason) => api.addLeaveType({ key: fresh.key, name: fresh.name.trim(), yearlyDays: fresh.limited ? fresh.yearlyDays : null, paid: fresh.paid, reason })).then(
                  (ok) => ok && setFresh({ key: "", name: "", yearlyDays: 0, limited: true, paid: true }),
                )
              }
            >
              <Plus /> Add leave type
            </Button>
          </div>
        )}
        <p className="text-[12px] text-muted-foreground">
          Who approves: the person&apos;s manager (or their stand-in), then the Director when the Director is above that manager. The Director&apos;s own leave goes to the CEO. Nobody approves their own leave.
        </p>
        <p className="text-[12px] text-muted-foreground">Unpaid leave days are passed to payroll at month end. Archived types stay on old requests but cannot be requested.</p>
      </CardContent>
    </Card>
  );
}
