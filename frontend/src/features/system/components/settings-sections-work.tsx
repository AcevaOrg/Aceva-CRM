"use client";
/** Settings sections: company, schedule, holidays, leave types, task sizes, score weights. */
import * as React from "react";
import { toast } from "sonner";
import { Plus, Save, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/controls";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/misc";
import { useReason } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { formatDate } from "@/lib/dates";
import { useCan } from "@/lib/auth/viewer";
import { cn } from "@/lib/utils";
import { useSaveWeights, useWeightVersions } from "../hooks";
import type { WeightsVersion } from "../types";
import { ChipsEditor, NumberInput, RecentChanges, SettingsSection } from "./settings-kit";

/** Label + hint on the left, control on the right. */
export function SettingRow({ label, hint, htmlFor, children, className }: { label: string; hint?: React.ReactNode; htmlFor?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-2 border-b border-dashed border-border pb-4 last:border-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:items-center sm:gap-6", className)}>
      <div>
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint && <p className="mt-1 text-[12px] text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/* ---------------- Company ---------------- */

type Company = { legalName: string; tradingName: string; ntn: string; secpNumber: string; address: string; phone: string; website: string; emailDomain: string; outreachPostalAddress: string };

export function CompanySection() {
  return (
    <SettingsSection<Company> section="company">
      {(d, set, can) => (
        <>
          <SettingRow label="Legal name" htmlFor="co-legal" hint="Printed on invoices, payslips and statements.">
            <Input id="co-legal" value={d.legalName} disabled={!can} onChange={(e) => set({ legalName: e.target.value })} />
          </SettingRow>
          <SettingRow label="Trading name" htmlFor="co-trade">
            <Input id="co-trade" value={d.tradingName} disabled={!can} onChange={(e) => set({ tradingName: e.target.value })} />
          </SettingRow>
          <SettingRow label="NTN and SECP number" hint="Tax and company registration numbers.">
            <div className="grid grid-cols-2 gap-2">
              <Input aria-label="NTN" className="font-mono" value={d.ntn} disabled={!can} onChange={(e) => set({ ntn: e.target.value })} />
              <Input aria-label="SECP number" className="font-mono" value={d.secpNumber} disabled={!can} onChange={(e) => set({ secpNumber: e.target.value })} />
            </div>
          </SettingRow>
          <SettingRow label="Registered address" htmlFor="co-addr">
            <Textarea id="co-addr" value={d.address} disabled={!can} onChange={(e) => set({ address: e.target.value })} className="min-h-16" />
          </SettingRow>
          <SettingRow label="Phone and website">
            <div className="grid grid-cols-2 gap-2">
              <Input aria-label="Phone" value={d.phone} disabled={!can} onChange={(e) => set({ phone: e.target.value })} />
              <Input aria-label="Website" value={d.website} disabled={!can} onChange={(e) => set({ website: e.target.value })} />
            </div>
          </SettingRow>
          <SettingRow label="Official email domain" htmlFor="co-domain" hint="Password reset links only go to this domain.">
            <Input id="co-domain" className="font-mono" value={d.emailDomain} disabled={!can} onChange={(e) => set({ emailDomain: e.target.value })} />
          </SettingRow>
          <SettingRow label="Postal address for outreach" htmlFor="co-postal" hint="Every sales email carries it (UK GDPR, US CAN-SPAM).">
            <Textarea id="co-postal" value={d.outreachPostalAddress} disabled={!can} onChange={(e) => set({ outreachPostalAddress: e.target.value })} className="min-h-16" />
          </SettingRow>
        </>
      )}
    </SettingsSection>
  );
}

/* ---------------- Working days and hours ---------------- */

type Schedule = { workingDays: string[]; startTime: string; endTime: string; graceMinutes: number; weeklyCapacity: number; internCapacity: number; autoCloseMissedCheckout: boolean; officeOnlyCheckIn: boolean; officeNetworks: string[] };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function ScheduleSection() {
  return (
    <SettingsSection<Schedule> section="schedule">
      {(d, set, can) => (
        <>
          <SettingRow label="Working days" hint="Tasks, leave and payroll count only these days.">
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((day) => {
                const on = d.workingDays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    disabled={!can}
                    aria-pressed={on}
                    onClick={() => set({ workingDays: on ? d.workingDays.filter((x) => x !== day) : DAYS.filter((x) => x === day || d.workingDays.includes(x)) })}
                    className={cn("h-9 w-12 rounded-lg border text-[12.5px] font-medium transition disabled:cursor-not-allowed", on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:bg-muted")}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
          </SettingRow>
          <SettingRow label="Working hours" hint="Check-in after start time plus the grace period is marked late.">
            <div className="grid grid-cols-3 gap-2">
              <Input type="time" aria-label="Start time" value={d.startTime} disabled={!can} onChange={(e) => set({ startTime: e.target.value })} />
              <Input type="time" aria-label="End time" value={d.endTime} disabled={!can} onChange={(e) => set({ endTime: e.target.value })} />
              <NumberInput value={d.graceMinutes} onChange={(n) => set({ graceMinutes: n })} suffix="min grace" disabled={!can} />
            </div>
          </SettingRow>
          <SettingRow label="Weekly capacity" hint="Used by the task workload check.">
            <div className="grid grid-cols-2 gap-2">
              <NumberInput value={d.weeklyCapacity} onChange={(n) => set({ weeklyCapacity: n })} suffix="h full-time" disabled={!can} />
              <NumberInput value={d.internCapacity} onChange={(n) => set({ internCapacity: n })} suffix="h part-time" disabled={!can} />
            </div>
          </SettingRow>
          <SettingRow label="Close missed check-outs" hint="At the end of working hours the day is closed and marked “missed check-out”.">
            <Switch checked={d.autoCloseMissedCheckout} disabled={!can} onCheckedChange={(v) => set({ autoCloseMissedCheckout: v })} aria-label="Close missed check-outs" />
          </SettingRow>
          <SettingRow label="Office-only check-in" hint="Office staff can check in only from the office network. Remote staff are not affected.">
            <Switch checked={d.officeOnlyCheckIn} disabled={!can} onCheckedChange={(v) => set({ officeOnlyCheckIn: v })} aria-label="Office-only check-in" />
          </SettingRow>
          <SettingRow label="Office networks">
            <ChipsEditor value={d.officeNetworks} onChange={(v) => set({ officeNetworks: v })} disabled={!can} placeholder="Office name · 10.0.0.0/24" />
          </SettingRow>
        </>
      )}
    </SettingsSection>
  );
}

/* ---------------- Holidays ---------------- */

type Holidays = { holidays: { date: string; name: string }[] };

export function HolidaysSection() {
  const [date, setDate] = React.useState("");
  const [name, setName] = React.useState("");
  return (
    <SettingsSection<Holidays> section="holidays">
      {(d, set, can) => {
        const sorted = [...d.holidays].sort((a, b) => a.date.localeCompare(b.date));
        return (
          <>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {sorted.map((h) => {
                const past = h.date < new Date().toISOString().slice(0, 10);
                return (
                  <li key={h.date + h.name} className={cn("flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]", past && "text-muted-foreground")}>
                    <span className="flex items-center gap-3">
                      <span className="w-28 font-mono tabular">{formatDate(h.date)}</span>
                      <span>{h.name}</span>
                      {h.name.includes("expected") && <Badge tone="outline">Moon sighting</Badge>}
                    </span>
                    {can && (
                      <Button size="icon-sm" variant="ghost" aria-label={`Remove ${h.name}`} onClick={() => set({ holidays: d.holidays.filter((x) => x !== h) })}>
                        <Trash2 />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            {can && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="hol-date">Date</Label>
                  <Input id="hol-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
                </div>
                <div className="grid flex-1 gap-1.5">
                  <Label htmlFor="hol-name">Name</Label>
                  <Input id="hol-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Company retreat" />
                </div>
                <Button
                  variant="outline"
                  disabled={!date || name.trim().length < 2}
                  onClick={() => {
                    set({ holidays: [...d.holidays, { date, name: name.trim() }] });
                    setDate("");
                    setName("");
                  }}
                >
                  <Plus /> Add holiday
                </Button>
              </div>
            )}
          </>
        );
      }}
    </SettingsSection>
  );
}

/* ---------------- Leave types ---------------- */

type LeaveTypes = { types: { name: string; days: number; paid: boolean }[] };

export function LeaveTypesSection() {
  return (
    <SettingsSection<LeaveTypes> section="leave-types">
      {(d, set, can) => {
        const update = (i: number, patch: Partial<LeaveTypes["types"][number]>) => set({ types: d.types.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
        return (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[480px] text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2">Leave type</th>
                    <th className="px-3 py-2">Days a year</th>
                    <th className="px-3 py-2">Paid</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {d.types.map((t, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">
                        <Input aria-label="Leave type name" value={t.name} disabled={!can} onChange={(e) => update(i, { name: e.target.value })} />
                      </td>
                      <td className="w-40 px-3 py-2">
                        <NumberInput value={t.days} onChange={(n) => update(i, { days: n })} suffix={t.days === 0 && !t.paid ? "no limit" : "days"} disabled={!can} />
                      </td>
                      <td className="px-3 py-2">
                        <Switch checked={t.paid} disabled={!can} onCheckedChange={(v) => update(i, { paid: v })} aria-label={`${t.name} is paid`} />
                      </td>
                      <td className="px-2">
                        {can && (
                          <Button size="icon-sm" variant="ghost" aria-label={`Remove ${t.name}`} onClick={() => set({ types: d.types.filter((_, j) => j !== i) })}>
                            <Trash2 />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[12px] text-muted-foreground">Unpaid leave days are passed to payroll at month end and deducted as base ÷ working days × unpaid days.</p>
            {can && (
              <Button variant="outline" className="w-fit" onClick={() => set({ types: [...d.types, { name: "New leave type", days: 0, paid: true }] })}>
                <Plus /> Add leave type
              </Button>
            )}
          </>
        );
      }}
    </SettingsSection>
  );
}

/* ---------------- Task sizes ---------------- */

type TaskSizes = { sizes: { size: string; meaning: string; hours: number; points: number; days: number | null }[] };

export function TaskSizesSection() {
  return (
    <SettingsSection<TaskSizes> section="task-sizes">
      {(d, set, can) => {
        const update = (i: number, patch: Partial<TaskSizes["sizes"][number]>) => set({ sizes: d.sizes.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
        return (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[640px] text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2">Size</th>
                    <th className="px-3 py-2">Meaning</th>
                    <th className="px-3 py-2">Estimated hours</th>
                    <th className="px-3 py-2">Points</th>
                    <th className="px-3 py-2">Suggested deadline</th>
                  </tr>
                </thead>
                <tbody>
                  {d.sizes.map((s, i) => (
                    <tr key={s.size} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">
                        <span className="grid size-8 place-content-center rounded-lg bg-zone-work/12 font-mono text-[12px] font-bold">{s.size}</span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{s.meaning}</td>
                      <td className="w-36 px-3 py-2">
                        <NumberInput value={s.hours} onChange={(n) => update(i, { hours: n })} suffix="h" disabled={!can} />
                      </td>
                      <td className="w-28 px-3 py-2">
                        {s.days === null ? <span className="text-muted-foreground">—</span> : <NumberInput value={s.points} onChange={(n) => update(i, { points: n })} disabled={!can} />}
                      </td>
                      <td className="w-44 px-3 py-2">
                        {s.days === null ? (
                          <Badge tone="warning">Must be split first</Badge>
                        ) : (
                          <NumberInput value={s.days} onChange={(n) => update(i, { days: n })} suffix={s.days === 0 ? "same day" : "working days"} disabled={!can} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[12px] text-muted-foreground">Changes apply to new tasks. Existing tasks keep their size, points and deadline.</p>
          </>
        );
      }}
    </SettingsSection>
  );
}

/* ---------------- Score weights (versions) ---------------- */

const STANDARD: { key: string; label: string; hint: string }[] = [
  { key: "quality", label: "Quality (Q)", hint: "Average reviewer rating, weighted by task points" },
  { key: "onTime", label: "On-time (T)", hint: "Submitted by the approved deadline" },
  { key: "completion", label: "Completion (C)", hint: "Points approved ÷ points due" },
  { key: "rework", label: "Rework (100 − R)", hint: "Fewer reworks score higher" },
  { key: "attendance", label: "Attendance (A)", hint: "Days on time ÷ working days" },
];
const SALES: { key: string; label: string; hint: string }[] = [
  { key: "activity", label: "Activity (V)", hint: "Days daily targets were met" },
  { key: "meetings", label: "Meetings (M)", hint: "Meetings booked ÷ monthly target" },
  { key: "won", label: "Deals won (W)", hint: "Value won ÷ monthly sales target" },
  { key: "dataQuality", label: "Data quality (D)", hint: "Bounce rate and duplicates" },
  { key: "attendance", label: "Attendance (A)", hint: "Same as standard" },
];

function WeightsEditor({ kind, title, fields, current, canEdit }: { kind: WeightsVersion["kind"]; title: string; fields: typeof STANDARD; current?: WeightsVersion; canEdit: boolean }) {
  // Parent keys this component by version id, so the draft resets when a new version is saved.
  const [draft, setDraft] = React.useState<Record<string, number>>(() => current?.weights ?? {});
  const save = useSaveWeights();
  const askReason = useReason();
  const total = fields.reduce((s, f) => s + (draft[f.key] ?? 0), 0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(current?.weights ?? {});
  const symbol = (label: string) => {
    const s = label.match(/\(([^)]+)\)/)?.[1] ?? "";
    return s.includes(" ") ? `(${s})` : s;
  };
  const formula = fields.map((f) => `${((draft[f.key] ?? 0) / 100).toFixed(2)} ${symbol(f.label)}`).join(" + ");

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{current ? `In use since ${formatDate(current.effectiveFrom)}.` : "No version yet."}</CardDescription>
        </div>
        <Badge tone={total === 100 ? "success" : "danger"}>Total {total}%</Badge>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex h-3 overflow-hidden rounded-full bg-muted" aria-hidden>
          {fields.map((f, i) => (
            <span key={f.key} style={{ width: `${Math.min(100, draft[f.key] ?? 0)}%`, background: `var(--chart-${i + 1})` }} />
          ))}
        </div>
        {fields.map((f, i) => (
          <div key={f.key} className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-3">
            <div className="flex items-start gap-2">
              <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: `var(--chart-${i + 1})` }} />
              <div>
                <p className="text-[13px] font-medium">{f.label}</p>
                <p className="text-[12px] text-muted-foreground">{f.hint}</p>
              </div>
            </div>
            <NumberInput value={draft[f.key] ?? 0} onChange={(n) => setDraft({ ...draft, [f.key]: n })} suffix="%" disabled={!canEdit} />
          </div>
        ))}
        <p className="rounded-lg bg-muted/60 px-3 py-2 font-mono text-[12px]">Score = {formula}</p>
      </CardContent>
      {canEdit && (
        <CardFooter className="justify-between">
          <span className="text-[12px] text-muted-foreground">{total !== 100 ? "Weights must add up to 100%." : "Saving creates a new version."}</span>
          <Button
            disabled={!dirty || total !== 100}
            loading={save.isPending}
            onClick={async () => {
              const reason = await askReason({ title: `New ${kind} score weights`, description: "Old scorecards keep the weights they were made with. Your reason is logged.", confirmLabel: "Save version" });
              if (!reason) return;
              save.mutate({ kind, weights: draft, reason }, { onSuccess: () => toast.success("New weights version saved", { description: "Used from the next scorecard run. Logged." }), onError: (e) => toast.error(e.message) });
            }}
          >
            <Save /> Save as new version
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

export function ScoreWeightsSection() {
  const q = useWeightVersions();
  const canEdit = useCan("performance.weights");
  if (!q.data) return <Skeleton className="h-96 rounded-xl" />;
  const latest = (k: WeightsVersion["kind"]) => q.data.find((v) => v.kind === k);
  return (
    <div className="grid gap-5">
      <div className="grid gap-5 2xl:grid-cols-2">
        <WeightsEditor key={latest("standard")?.id ?? "standard"} kind="standard" title="Standard scorecard" fields={STANDARD} current={latest("standard")} canEdit={canEdit} />
        <WeightsEditor key={latest("sales")?.id ?? "sales"} kind="sales" title="Sales scorecard" fields={SALES} current={latest("sales")} canEdit={canEdit} />
      </div>
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Version history</h3>
        <ul className="grid gap-2">
          {q.data.map((v, i) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-[12.5px]">
              <span className="flex items-center gap-2">
                <Badge tone={v.kind === "sales" ? "sales" : "work"}>{v.kind === "sales" ? "Sales" : "Standard"}</Badge>
                {i === q.data.findIndex((x) => x.kind === v.kind) && <Badge tone="success">Current</Badge>}
                <span className="font-mono text-muted-foreground">{Object.values(v.weights).join(" / ")}</span>
              </span>
              <span className="flex items-center gap-3 text-muted-foreground">
                {v.note && <span>“{v.note}”</span>}
                <span>{formatDate(v.effectiveFrom)}</span>
                <EmpChip empId={v.createdBy} size="sm" showId={false} />
              </span>
            </li>
          ))}
        </ul>
      </section>
      <RecentChanges section="score-weights" />
    </div>
  );
}
