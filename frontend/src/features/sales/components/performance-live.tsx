"use client";
/**
 * Module 15.6 screens in live mode (the server's data): today's targets and the self-reported log on My sales day, the log
 * form, the nightly daily report with proof requests, the dashboard, and the targets tab. Emails checked always reads
 * "Not measured yet"; money is listed per currency and never converted.
 */
import * as React from "react";
import { toast } from "sonner";
import { Camera, CircleCheck, CircleMinus, CircleX, Pencil, Wallet } from "lucide-react";
import { SALES_DAILY_METRICS, SALES_LOG_FIELDS, type SalesDailyReportView, type SalesLogField, type SalesTargetsRowView } from "@aceva/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton, Table, TBody, TD, TH, THead, TR } from "@/components/ui/misc";
import { useReason } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { StatCard } from "@/components/shared/metrics";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { isoDay, monthKey } from "@/lib/dates";
import { STAGE_META, SOURCE_LABEL } from "../logic";
import {
  useLiveDashboard,
  useLiveLog,
  useLiveProgress,
  useLiveProofs,
  useLiveReportDates,
  useLiveReports,
  useLiveTargets,
  useProofActions,
  useSaveLiveLog,
  useSetDailyTargets,
  useSetMonthlyTargets,
} from "../hooks";
import { currencyLines, dayResult, LOG_FIELD_LABEL, METRIC_LABEL, metricText, money, NOT_MEASURED, selfReportedTotal } from "../performance-live";

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/* ---------------- My sales day: today's targets and the self-reported log ---------------- */

export function LiveTodayCards({ empId, canLog, onLog }: { empId: string; canLog: boolean; onLog: () => void }) {
  const p = useLiveProgress(empId);
  const log = useLiveLog(isoDay(new Date()), empId);
  if (p.isPending) return <Skeleton className="h-48 rounded-xl" />;
  if (p.isError) return <ErrorState error={p.error} onRetry={() => p.refetch()} />;
  const r = dayResult(p.data.today.met);
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Today&apos;s targets</CardTitle>
            <p className="text-[12.5px] text-muted-foreground">Counted from what is added and logged in Aceva. Emails checked is measured once the email-check tool is connected.</p>
          </div>
          <Badge tone={r.tone} dot>
            {r.label}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {SALES_DAILY_METRICS.map((k) => {
              const m = p.data.today.metrics[k];
              return (
                <div key={k} className="grid gap-1 rounded-xl border border-border p-3 text-center">
                  <span className="text-[12px] text-muted-foreground">{METRIC_LABEL[k]}</span>
                  <span className={m.measured ? "font-mono text-[18px] font-semibold tabular" : "text-[12.5px] text-muted-foreground"}>{metricText(m)}</span>
                  <MetIcon met={m.met} measured={m.measured} />
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
      <Card className="flex flex-col">
        <CardHeader>
          <div>
            <CardTitle>Self-reported today</CardTitle>
            <p className="text-[12.5px] text-muted-foreground">Work outside the connected tools, marked self-reported.</p>
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-2">
          {log.data ? (
            <>
              <ul className="grid gap-1.5">
                {SALES_LOG_FIELDS.map((f) => (
                  <li key={f} className="flex items-center justify-between text-[13px]">
                    <span>{LOG_FIELD_LABEL[f]}</span>
                    <span className="font-mono font-semibold tabular">{log.data!.counts[f]}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-auto flex items-center justify-between pt-2">
                <Badge tone="outline">
                  {selfReportedTotal(log.data.counts)} self-reported · version {log.data.version}
                </Badge>
                {canLog && !log.data.locked && (
                  <Button size="sm" variant="ghost" onClick={onLog}>
                    Edit
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p className="text-[13px] text-muted-foreground">{canLog ? "Nothing logged yet today." : "No log yet today."}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MetIcon({ met, measured }: { met: boolean | null; measured: boolean }) {
  if (!measured) return <span className="text-[11px] text-muted-foreground">left out</span>;
  if (met === null) return <span className="text-[11px] text-muted-foreground">no target</span>;
  return met ? <CircleCheck className="mx-auto size-4 text-success" aria-label="Met" /> : <CircleX className="mx-auto size-4 text-warning" aria-label="Not met" />;
}

/** The home widget's figures in live mode. */
export function LiveWidgetTargets() {
  const p = useLiveProgress();
  if (!p.data) return <Skeleton className="h-16 rounded-lg" />;
  return (
    <div className="grid grid-cols-4 gap-2 text-center">
      {SALES_DAILY_METRICS.map((k) => (
        <div key={k} className="grid gap-0.5 rounded-lg border border-border px-1 py-2">
          <span className="text-[11px] text-muted-foreground">{METRIC_LABEL[k]}</span>
          <span className={p.data.today.metrics[k].measured ? "font-mono text-[14px] font-semibold tabular" : "text-[10.5px] text-muted-foreground"}>{metricText(p.data.today.metrics[k])}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- the daily log form ---------------- */

export function LiveDailyLogSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const day = isoDay(new Date());
  const log = useLiveLog(day);
  const save = useSaveLiveLog();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>My daily log</SheetTitle>
          <SheetDescription>Work outside the connected tools today. Counts are marked self-reported; every save is kept as a new version until tonight&apos;s report.</SheetDescription>
        </SheetHeader>
        {log.isPending ? (
          <SheetBody>
            <Skeleton className="h-64 rounded-xl" />
          </SheetBody>
        ) : (
          <LogForm
            key={log.data?.version ?? 0}
            initial={log.data ?? null}
            busy={save.isPending}
            onCancel={() => onOpenChange(false)}
            onSave={(counts, note) =>
              save.mutate(
                { day, body: { ...counts, note: note || null, version: log.data?.version ?? 0 } },
                { onSuccess: (v) => { toast.success("Log saved", { description: `Version ${v.version}` }); onOpenChange(false); }, onError: (e) => toast.error(errorText(e, "Couldn't save the log.")) },
              )
            }
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function LogForm({ initial, busy, onCancel, onSave }: { initial: { counts: Record<SalesLogField, number>; note: string | null; locked: boolean } | null; busy: boolean; onCancel: () => void; onSave: (counts: Record<SalesLogField, number>, note: string) => void }) {
  const [counts, setCounts] = React.useState<Record<SalesLogField, number>>(initial?.counts ?? { linkedin: 0, whatsapp: 0, fiverr: 0, calls: 0, fieldVisits: 0 });
  const [note, setNote] = React.useState(initial?.note ?? "");
  const locked = !!initial?.locked;
  return (
    <>
      <SheetBody className="grid gap-4">
        {locked && <p className="rounded-lg bg-muted px-3 py-2 text-[12.5px]">Today&apos;s report is already built: this log no longer changes.</p>}
        {SALES_LOG_FIELDS.map((f) => (
          <Field key={f} label={LOG_FIELD_LABEL[f]} htmlFor={`log-${f}`}>
            <Input id={`log-${f}`} inputMode="numeric" disabled={locked} value={String(counts[f])} onChange={(e) => setCounts({ ...counts, [f]: Math.min(1000, Number(e.target.value.replace(/[^0-9]/g, "") || 0)) })} className="w-28 font-mono" />
          </Field>
        ))}
        <Field label="Note" htmlFor="log-note" hint="Only work facts.">
          <Textarea id="log-note" disabled={locked} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </SheetBody>
      <SheetFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={locked} loading={busy} onClick={() => onSave(counts, note.trim())}>
          Save log
        </Button>
      </SheetFooter>
    </>
  );
}

/* ---------------- the nightly daily report ---------------- */

export function LiveDailyReport({ canAskProof, myEmpId }: { canAskProof: boolean; myEmpId: string }) {
  const dates = useLiveReportDates();
  const [picked, setPicked] = useUrlState<string>("date", "");
  const day = picked || dates.data?.[0];
  const reports = useLiveReports(day);
  const proofs = useLiveProofs();
  const actions = useProofActions();
  const askReason = useReason();

  if (dates.isPending) return <Skeleton className="h-48 rounded-xl" />;
  if (dates.isError) return <ErrorState error={dates.error} onRetry={() => dates.refetch()} />;
  if (!dates.data.length) return <EmptyState title="No daily report yet" description="Reports are built every night at 00:30 for each working day." />;
  const proofOf = (r: SalesDailyReportView) => (r.proof ? proofs.data?.find((p) => p.id === r.proof!.id) : undefined);

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <NativeSelect aria-label="Report day" value={day ?? ""} onChange={(e) => setPicked(e.target.value)} className="w-56">
          {dates.data.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </NativeSelect>
        <p className="text-[12.5px] text-muted-foreground">Built at 00:30 and kept as it was: later changes do not alter it. {NOT_MEASURED}: emails checked.</p>
      </div>
      {reports.isError ? (
        <ErrorState error={reports.error} onRetry={() => reports.refetch()} />
      ) : !reports.data ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : (
        <div className="overflow-auto rounded-xl border border-border">
          <Table>
            <THead>
              <tr>
                <TH>Salesperson</TH>
                {SALES_DAILY_METRICS.map((k) => (
                  <TH key={k}>{METRIC_LABEL[k]}</TH>
                ))}
                <TH>Self-reported</TH>
                <TH>Result</TH>
                <TH>Proof</TH>
              </tr>
            </THead>
            <TBody>
              {reports.data.map((r) => {
                const res = dayResult(r.met);
                const proof = proofOf(r);
                return (
                  <TR key={r.id}>
                    <TD>
                      <EmpChip empId={r.person.empId} size="sm" />
                    </TD>
                    {SALES_DAILY_METRICS.map((k) => (
                      <TD key={k} className={r.metrics[k].measured ? "font-mono tabular" : "text-[12px] text-muted-foreground"}>
                        {metricText(r.metrics[k])}
                      </TD>
                    ))}
                    <TD className="font-mono tabular">{r.log ? `${selfReportedTotal(r.log.counts)} (v${r.log.version})` : "—"}</TD>
                    <TD>
                      <Badge tone={res.tone}>{res.label}</Badge>
                    </TD>
                    <TD>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {r.proof && <Badge tone={r.proof.status === "closed" ? "outline" : "warning"}>{r.proof.status}</Badge>}
                        {canAskProof && r.log && (!r.proof || r.proof.status === "closed") && r.person.empId !== myEmpId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              const note = await askReason({ title: `Ask ${r.person.name} for proof`, description: `About the self-reported work of ${r.day}. They are notified.`, confirmLabel: "Ask for proof" });
                              if (note) actions.request.mutate({ empId: r.person.empId, day: r.day, note }, { onSuccess: () => toast.success("Proof requested"), onError: (e) => toast.error(errorText(e, "Couldn't ask.")) });
                            }}
                          >
                            <Camera /> Ask for proof
                          </Button>
                        )}
                        {proof && proof.status === "open" && proof.person.empId === myEmpId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              const answer = await askReason({ title: "Answer the proof request", description: proof.note, confirmLabel: "Send answer", placeholder: "For example: sent the screenshots in a message" });
                              if (answer) actions.answer.mutate({ id: proof.id, answer }, { onSuccess: () => toast.success("Answer sent"), onError: (e) => toast.error(errorText(e, "Couldn't answer.")) });
                            }}
                          >
                            Answer
                          </Button>
                        )}
                        {proof && proof.status !== "closed" && canAskProof && proof.person.empId !== myEmpId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              const note = await askReason({ title: "Close the proof request", description: proof.answer ? `Answer: ${proof.answer}` : "Not answered yet.", confirmLabel: "Close" });
                              if (note) actions.close.mutate({ id: proof.id, note }, { onSuccess: () => toast.success("Closed"), onError: (e) => toast.error(errorText(e, "Couldn't close.")) });
                            }}
                          >
                            Close
                          </Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ---------------- the dashboard ---------------- */

export function LiveDashboard() {
  const [month, setMonth] = useUrlState<string>("month", "");
  const q = useLiveDashboard(month || undefined);
  if (q.isPending) return <Skeleton className="h-64 rounded-xl" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const open = d.pipeline.flatMap((s) => s.totals);
  const openByCurrency = Object.values(
    open.reduce<Record<string, { currency: string; total: number }>>((m, t) => ((m[t.currency] = { currency: t.currency, total: (m[t.currency]?.total ?? 0) + Number(t.total) }), m), {}),
  ).map((t) => money(String(t.total), t.currency as "USD" | "PKR"));
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Input type="month" aria-label="Month" value={month || d.month} onChange={(e) => setMonth(e.target.value)} className="w-44" />
        <p className="text-[12.5px] text-muted-foreground">Money is shown per currency: USD and PKR are never added together or converted.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open pipeline" value={openByCurrency.join(" · ") || "—"} icon={<Wallet />} accent="var(--zone-sales)" />
        <StatCard label="Won this month" value={currencyLines(d.won.totals).join(" · ")} hint={`${d.won.count} deals`} icon={<CircleCheck />} />
        <StatCard label="Lost this month" value={currencyLines(d.lost.totals).join(" · ")} hint={`${d.lost.count} deals`} icon={<CircleMinus />} />
        <StatCard label="Leads (active)" value={d.leadsBySource.reduce((n, s) => n + s.count, 0)} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pipeline by stage</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TBody>
                {d.pipeline.map((s) => (
                  <TR key={s.stage}>
                    <TD>{STAGE_META[s.stage].label}</TD>
                    <TD className="font-mono tabular">{s.count}</TD>
                    <TD className="text-right text-[12.5px]">{currencyLines(s.totals).join(" · ")}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Moves to the next stage this month</CardTitle>
              <p className="text-[12.5px] text-muted-foreground">From the stage history, only moves to the very next stage.</p>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TBody>
                {d.stageMoves.map((m) => (
                  <TR key={`${m.from}-${m.to}`}>
                    <TD>
                      {STAGE_META[m.from].label} → {STAGE_META[m.to].label}
                    </TD>
                    <TD className="text-right font-mono tabular">{m.count}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Leads by source and country</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-[13px]">
            <ul className="grid gap-1">
              {d.leadsBySource.map((s) => (
                <li key={s.source} className="flex justify-between">
                  <span>{SOURCE_LABEL[s.source]}</span>
                  <span className="font-mono tabular">{s.count}</span>
                </li>
              ))}
            </ul>
            <ul className="grid gap-1">
              {d.leadsByCountry.map((c) => (
                <li key={c.country} className="flex justify-between">
                  <span>{c.country}</span>
                  <span className="font-mono tabular">{c.count}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Each person</CardTitle>
            <p className="text-[12.5px] text-muted-foreground">Today so far, the last report, and this month. Emails checked: {NOT_MEASURED.toLowerCase()}.</p>
          </div>
        </CardHeader>
        <CardContent className="overflow-auto">
          <Table>
            <THead>
              <tr>
                <TH>Salesperson</TH>
                {SALES_DAILY_METRICS.map((k) => (
                  <TH key={k}>{METRIC_LABEL[k]}</TH>
                ))}
                <TH>Today</TH>
                <TH>Last report</TH>
                <TH>Meetings</TH>
                <TH>Proposals</TH>
                <TH>Won this month</TH>
              </tr>
            </THead>
            <TBody>
              {d.people.map((p) => (
                <TR key={p.person.empId}>
                  <TD>
                    <EmpChip empId={p.person.empId} size="sm" />
                  </TD>
                  {SALES_DAILY_METRICS.map((k) => (
                    <TD key={k} className={p.today.metrics[k].measured ? "font-mono tabular" : "text-[12px] text-muted-foreground"}>
                      {metricText(p.today.metrics[k])}
                    </TD>
                  ))}
                  <TD>
                    <Badge tone={dayResult(p.today.met).tone}>{dayResult(p.today.met).label}</Badge>
                  </TD>
                  <TD className="text-[12.5px]">{p.lastReport ? `${p.lastReport.day}: ${dayResult(p.lastReport.met).label}` : "None yet"}</TD>
                  <TD className="font-mono tabular">{metricText(p.month.meetingsBooked)}</TD>
                  <TD className="font-mono tabular">{metricText(p.month.proposalsSent)}</TD>
                  <TD className="text-[12.5px]">
                    {p.month.wonValue.target ? `${money(p.month.wonValue.inTargetCurrency ?? "0", p.month.wonValue.target.currency)} of ${money(p.month.wonValue.target.amount, p.month.wonValue.target.currency)}` : "No target"}
                    {p.month.wonValue.byCurrency.filter((c) => c.currency !== p.month.wonValue.target?.currency).map((c) => (
                      <span key={c.currency} className="block text-muted-foreground">
                        + {money(c.total, c.currency)} (not counted: other currency)
                      </span>
                    ))}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------- targets ---------------- */

export function LiveTargetsTab() {
  const month = monthKey();
  const q = useLiveTargets(month);
  const [editing, setEditing] = React.useState<SalesTargetsRowView | null>(null);
  if (q.isPending) return <Skeleton className="h-48 rounded-xl" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data.length) return <EmptyState title="No sales staff" description="Targets are set for the sales staff." />;
  return (
    <div className="grid gap-4">
      <p className="text-[12.5px] text-muted-foreground">The sales manager sets daily targets from a day on and monthly targets for a month. A past day keeps the targets it had. Emails checked is {NOT_MEASURED.toLowerCase()} until the email-check tool is connected.</p>
      <div className="overflow-auto rounded-xl border border-border">
        <Table>
          <THead>
            <tr>
              <TH>Salesperson</TH>
              {SALES_DAILY_METRICS.map((k) => (
                <TH key={k}>{METRIC_LABEL[k]} / day</TH>
              ))}
              <TH>Meetings / month</TH>
              <TH>Proposals / month</TH>
              <TH>Deals won / month</TH>
              <TH />
            </tr>
          </THead>
          <TBody>
            {q.data.map((r) => (
              <TR key={r.person.empId}>
                <TD>
                  <EmpChip empId={r.person.empId} size="sm" />
                  {r.dailyNext && <span className="block text-[11px] text-muted-foreground">Changes on {r.dailyNext.effectiveFrom}</span>}
                </TD>
                {SALES_DAILY_METRICS.map((k) => (
                  <TD key={k} className="font-mono tabular">
                    {r.daily?.[k] ?? "—"}
                  </TD>
                ))}
                <TD className="font-mono tabular">{r.monthly?.meetingsBooked ?? "—"}</TD>
                <TD className="font-mono tabular">{r.monthly?.proposalsSent ?? "—"}</TD>
                <TD className="text-[12.5px]">{r.monthly?.wonValue ? money(r.monthly.wonValue.amount, r.monthly.wonValue.currency) : "—"}</TD>
                <TD className="text-right">
                  {r.canEdit && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(r)} aria-label={`Edit the targets of ${r.person.name}`}>
                      <Pencil /> Edit
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      {editing && <TargetsDialog row={editing} month={month} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TargetsDialog({ row, month, onClose }: { row: SalesTargetsRowView; month: string; onClose: () => void }) {
  const setDaily = useSetDailyTargets();
  const setMonthly = useSetMonthlyTargets();
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  const [from, setFrom] = React.useState(isoDay(new Date()));
  const [d, setD] = React.useState<Record<string, string>>(Object.fromEntries(SALES_DAILY_METRICS.map((k) => [k, num(row.daily?.[k])])));
  const [meetings, setMeetings] = React.useState(num(row.monthly?.meetingsBooked));
  const [proposals, setProposals] = React.useState(num(row.monthly?.proposalsSent));
  const [wonAmount, setWonAmount] = React.useState(row.monthly?.wonValue?.amount ?? "");
  const [wonCurrency, setWonCurrency] = React.useState<"USD" | "PKR">(row.monthly?.wonValue?.currency ?? "USD");
  const toNum = (v: string) => (v.trim() === "" ? null : Number(v));
  const busy = setDaily.isPending || setMonthly.isPending;
  const save = async () => {
    try {
      await setDaily.mutateAsync({ empId: row.person.empId, effectiveFrom: from, ...(Object.fromEntries(SALES_DAILY_METRICS.map((k) => [k, toNum(d[k])])) as Record<string, number | null>) });
      await setMonthly.mutateAsync({ empId: row.person.empId, month, meetingsBooked: toNum(meetings), proposalsSent: toNum(proposals), wonValue: wonAmount.trim() ? { amount: wonAmount.trim(), currency: wonCurrency } : null });
      toast.success("Targets saved");
      onClose();
    } catch (e) {
      toast.error(errorText(e, "Couldn't save the targets."));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Targets of {row.person.name}</DialogTitle>
          <DialogDescription>Empty means no target. Daily targets apply from the chosen day; monthly ones for {month}.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Daily targets from" htmlFor="tg-from">
            <Input id="tg-from" type="date" min={isoDay(new Date())} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <span />
          {SALES_DAILY_METRICS.map((k) => (
            <Field key={k} label={`${METRIC_LABEL[k]} per day`} htmlFor={`tg-${k}`} hint={k === "emailsChecked" ? NOT_MEASURED : undefined}>
              <Input id={`tg-${k}`} inputMode="numeric" value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value.replace(/[^0-9]/g, "") })} className="w-28 font-mono" />
            </Field>
          ))}
          <Field label="Meetings booked this month" htmlFor="tg-meet">
            <Input id="tg-meet" inputMode="numeric" value={meetings} onChange={(e) => setMeetings(e.target.value.replace(/[^0-9]/g, ""))} className="w-28 font-mono" />
          </Field>
          <Field label="Proposals sent this month" htmlFor="tg-prop">
            <Input id="tg-prop" inputMode="numeric" value={proposals} onChange={(e) => setProposals(e.target.value.replace(/[^0-9]/g, ""))} className="w-28 font-mono" />
          </Field>
          <Field label="Deals won this month" htmlFor="tg-won" hint="Only deals in this currency count; the other is shown apart.">
            <div className="flex gap-2">
              <NativeSelect aria-label="Currency" value={wonCurrency} onChange={(e) => setWonCurrency(e.target.value as "USD" | "PKR")} className="w-24">
                <option value="USD">USD</option>
                <option value="PKR">PKR</option>
              </NativeSelect>
              <Input id="tg-won" inputMode="decimal" value={wonAmount} onChange={(e) => setWonAmount(e.target.value.replace(/[^0-9.]/g, ""))} className="w-36 font-mono" />
            </div>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={save}>
            Save targets
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
