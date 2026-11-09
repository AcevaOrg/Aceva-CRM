"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, CircleDashed, Lock, LockOpen, Repeat, RotateCcw, ShieldCheck, X } from "lucide-react";
import { PageHeader, SectionTitle } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/misc";
import { Tip } from "@/components/ui/overlays";
import { ApprovalRelay, MakerCheckerNote } from "@/components/shared/approval-relay";
import { RequireAccess } from "@/components/shared/can";
import { useReason, useStepUp } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { Money } from "@/components/shared/money";
import { ErrorState, ListSkeleton } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useViewer } from "@/lib/auth/viewer";
import { formatDateTime, formatMonthKey } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useAccounts, useApproveClose, usePeriods, usePostRevaluation, useRejectClose, useReopenMonth, useRevaluationPreview, useRunClose } from "../hooks";
import { canApproveClose, canRunClose, num } from "../logic";
import type { FinancePeriod } from "../types";
import { ViewOnlyNote } from "./ledger-bits";

export function CloseScreen() {
  return (
    <RequireAccess permission="finance.view" mode="404">
      <Close />
    </RequireAccess>
  );
}

function Close() {
  const q = usePeriods();
  if (q.isPending) return <ListSkeleton rows={8} className="mt-6" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const active = q.data.filter((p) => p.status !== "closed");
  const closed = q.data.filter((p) => p.status === "closed");
  return (
    <>
      <PageHeader
        title="Month close"
        description="When the checklist is complete the finance person runs the close and the Director approves it. The month is then locked and its statements saved as a snapshot."
        seal="highly"
      />
      <div className="grid gap-6">
        {active.map((p) => (
          <OpenPeriod key={p.month} period={p} />
        ))}
        <section>
          <SectionTitle title="Closed months" description="Only the Director can reopen a closed month, with a step-up check and a written reason. Reopening is logged and the CEO / Founder / Owner is notified." />
          <ClosedTable periods={closed} />
        </section>
      </div>
    </>
  );
}

function OpenPeriod({ period }: { period: FinancePeriod }) {
  const viewer = useViewer();
  const lookup = useLookup();
  const run = useRunClose();
  const approve = useApproveClose();
  const reject = useRejectClose();
  const stepUp = useStepUp();
  const askReason = useReason();
  const [reval, setReval] = React.useState(false);
  const allDone = period.checklist.every((c) => c.done);
  const missing = period.checklist.filter((c) => !c.done);
  // The finance person runs the close; the Director approves it (maker-checker). The CEO / Founder / Owner views only.
  const canRun = !!viewer && canRunClose(viewer.can);
  const canApprove = !!viewer && canApproveClose(viewer.can);
  const isMaker = period.closedBy === viewer?.employee.empId;
  const done = period.checklist.filter((c) => c.done).length;

  const financePerson = lookup.employees.find((e) => e.duties.includes("finance") && e.status !== "left")?.empId;
  const director = lookup.employees.find((e) => e.role === "director" && e.status !== "left")?.empId;
  const closing = period.status === "closing";
  const steps = [
    { label: "Run by (Finance)", empId: closing ? period.closedBy : financePerson, state: closing ? ("done" as const) : ("waiting" as const), at: closing ? period.closedAt : undefined },
    { label: "Approved by (Director)", empId: director, state: closing ? ("waiting" as const) : ("pending" as const) },
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border pb-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{period.status === "reopened" ? "Reopened month" : "Current month"}</p>
          <CardTitle className="text-xl">{formatMonthKey(period.month)}</CardTitle>
          {period.reopenReason && <p className="mt-1 text-[12.5px] text-muted-foreground">{period.reopenReason}</p>}
        </div>
        <Badge tone={period.status === "closing" ? "warning" : period.status === "reopened" ? "danger" : "info"} dot>
          {period.status === "closing" ? "Waiting for Director approval" : period.status === "reopened" ? "Reopened" : "Open"}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-6 pt-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[13px] font-semibold">Checklist</p>
            <span className="text-[12px] text-muted-foreground tabular">{done} of {period.checklist.length} done</span>
          </div>
          <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full transition-[width]", allDone ? "bg-success" : "bg-zone-finance")} style={{ width: `${(done / period.checklist.length) * 100}%` }} />
          </div>
          <ul className="grid gap-2">
            {period.checklist.map((c) => (
              <li key={c.key} className={cn("flex items-start gap-3 rounded-xl border px-4 py-3", c.done ? "border-success/25 bg-success/5" : "border-border bg-card")}>
                <span className={cn("mt-0.5 grid size-5 shrink-0 place-content-center rounded-full", c.done ? "bg-success text-white" : "border border-dashed border-muted-foreground/50 text-muted-foreground")}>
                  {c.done ? <Check className="size-3" strokeWidth={3} /> : <CircleDashed className="size-3" />}
                </span>
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="text-[13.5px] font-medium">{c.label}</span>
                  <span className="text-[12px] text-muted-foreground">{c.detail}</span>
                </span>
                {!c.done && c.key === "entries_posted" && <Link className="shrink-0 text-[12.5px] font-medium text-primary hover:underline" href={`/finance/ledger?month=${period.month}`}>Open entries</Link>}
                {!c.done && c.key === "bank_reconciled" && <Link className="shrink-0 text-[12.5px] font-medium text-primary hover:underline" href={`/finance/banking?tab=reconcile&month=${period.month}`}>Reconcile</Link>}
                {!c.done && c.key === "payroll_posted" && <Link className="shrink-0 text-[12.5px] font-medium text-primary hover:underline" href="/payroll">Payroll</Link>}
                {!c.done && c.key === "usd_revalued" && viewer?.can("finance.entry_create") && (
                  <Button size="sm" variant="outline" onClick={() => setReval(true)}>
                    <Repeat /> Revalue USD
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="grid content-start gap-4">
          <ApprovalRelay steps={steps} />
          {period.status !== "closing" && (
            <>
              {canRun ? (
                <Tip content={!allDone ? `Still to do: ${missing.map((m) => m.label.toLowerCase()).join(", ")}` : undefined}>
                  <span>
                    <Button
                      className="w-full"
                      disabled={!allDone}
                      loading={run.isPending}
                      onClick={async () => {
                        try {
                          await run.mutateAsync(period.month);
                          toast.success(`${formatMonthKey(period.month)} sent to the Director for approval`);
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : "Couldn't run the close.");
                        }
                      }}
                    >
                      <Lock /> Run close
                    </Button>
                  </span>
                </Tip>
              ) : canApprove ? (
                <MakerCheckerNote reason="The finance person runs the close when every item is done. Then it comes to you for approval." />
              ) : (
                <ViewOnlyNote>View only. The finance person runs the close and the Director approves it.</ViewOnlyNote>
              )}
              {!allDone && <p className="text-[12.5px] text-muted-foreground">Finish the checklist first. Every item updates live from the ledger.</p>}
            </>
          )}
          {period.status === "closing" && canApprove && !isMaker && (
            <div className="grid gap-2">
              <Button
                loading={approve.isPending}
                onClick={async () => {
                  if (!(await stepUp({ action: `Approve the close of ${formatMonthKey(period.month)}`, detail: "The month is locked and its statements saved as a snapshot." }))) return;
                  await approve.mutateAsync(period.month);
                  toast.success(`${formatMonthKey(period.month)} closed`, { description: "Entries for this month are now locked." });
                }}
              >
                <ShieldCheck /> Approve close
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  const reason = await askReason({ title: "Send the close back", destructive: true, confirmLabel: "Send back" });
                  if (reason) await reject.mutateAsync({ month: period.month, reason });
                }}
              >
                <X /> Send back
              </Button>
            </div>
          )}
          {period.status === "closing" && isMaker && <MakerCheckerNote reason="You ran this close, so you can't approve it. It goes to the Director." />}
          {period.status === "closing" && !isMaker && !canApprove && <ViewOnlyNote>View only. Waiting for the Director to approve the close.</ViewOnlyNote>}
        </div>
      </CardContent>
      {reval && <RevaluationDialog month={period.month} onClose={() => setReval(false)} />}
    </Card>
  );
}

function RevaluationDialog({ month, onClose }: { month: string; onClose: () => void }) {
  const [typed, setRateText] = React.useState<string | null>(null);
  const typedRate = typed !== null && Number(typed) > 0 ? Number(typed) : undefined;
  const preview = useRevaluationPreview(month, typedRate);
  const accounts = useAccounts();
  const post = usePostRevaluation();
  const rateText = typed ?? preview.data?.rate ?? "";
  const rate = Number(rateText) > 0 ? Number(rateText) : undefined;
  const total = num(preview.data?.total);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Revalue USD balances for {formatMonthKey(month)}</DialogTitle>
          <DialogDescription>USD balances are restated at the month-end rate. The gain or loss is posted to profit and loss (plan §13).</DialogDescription>
        </DialogHeader>
        <Field label="Month-end rate (PKR per USD)" htmlFor="rv-rate" className="max-w-56">
          <Input id="rv-rate" inputMode="decimal" value={rateText} onChange={(e) => setRateText(e.target.value)} className="font-mono" />
        </Field>
        {preview.isPending ? (
          <ListSkeleton rows={3} />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Account</TH>
                <TH className="text-right">USD balance</TH>
                <TH className="text-right">Book value</TH>
                <TH className="text-right">At new rate</TH>
                <TH className="text-right">Difference</TH>
              </tr>
            </THead>
            <TBody>
              {preview.data?.rows.map((r) => (
                <TR key={r.accountId}>
                  <TD className="font-medium">{accounts.data?.find((a) => a.id === r.accountId)?.name}</TD>
                  <TD className="text-right"><Money value={{ amount: r.foreign, currency: "USD" }} exact /></TD>
                  <TD className="text-right"><Money value={num(r.bookBase)} exact /></TD>
                  <TD className="text-right"><Money value={num(r.revaluedBase)} exact /></TD>
                  <TD className="text-right"><Money value={num(r.difference)} exact sign tone="auto" /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <p className="text-[13px]">
          {total >= 0 ? "Exchange gain" : "Exchange loss"} of <Money value={Math.abs(total)} exact className="font-semibold" />. The entry goes for approval.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!rate || Math.abs(total) < 0.01}
            loading={post.isPending}
            onClick={async () => {
              try {
                const e = await post.mutateAsync({ month, rate: rate! });
                toast.success(`Revaluation ${e.number} sent for approval`);
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Couldn't post the revaluation.");
              }
            }}
          >
            Create revaluation entry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClosedTable({ periods }: { periods: FinancePeriod[] }) {
  const viewer = useViewer();
  const reopen = useReopenMonth();
  const stepUp = useStepUp();
  const askReason = useReason();
  const canReopen = viewer?.can("finance.reopen");
  if (!periods.length) return <p className="text-[13px] text-muted-foreground">No closed months yet.</p>;
  return (
    <Card className="overflow-hidden">
      <Table>
        <THead>
          <tr>
            <TH>Month</TH>
            <TH>Closed by</TH>
            <TH>Approved by</TH>
            <TH>Locked since</TH>
            <TH className="text-right">Statements</TH>
            {canReopen && <TH />}
          </tr>
        </THead>
        <TBody>
          {periods.map((p) => {
            const [y, m] = p.month.split("-").map(Number);
            const last = new Date(y, m, 0).getDate();
            return (
              <TR key={p.month}>
                <TD className="font-medium">
                  <span className="flex items-center gap-2"><Lock className="size-3.5 text-muted-foreground" /> {formatMonthKey(p.month)}</span>
                </TD>
                <TD><EmpChip empId={p.closedBy} size="sm" showId={false} /></TD>
                <TD><EmpChip empId={p.approvedBy} size="sm" showId={false} /></TD>
                <TD className="text-muted-foreground">{p.approvedAt ? formatDateTime(p.approvedAt) : "—"}</TD>
                <TD className="text-right">
                  <Link className="text-[12.5px] font-medium text-primary hover:underline" href={`/finance/statements?type=balance-sheet&from=${p.month}-01&to=${p.month}-${String(last).padStart(2, "0")}`}>
                    Snapshot
                  </Link>
                </TD>
                {canReopen && (
                  <TD className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={reopen.isPending && reopen.variables?.month === p.month}
                      onClick={async () => {
                        const reason = await askReason({
                          title: `Reopen ${formatMonthKey(p.month)}`,
                          description: "Reopening lets entries be dated in this month again. It is logged in the audit trail and the CEO / Founder / Owner is notified.",
                          confirmLabel: "Continue",
                          destructive: true,
                        });
                        if (!reason) return;
                        if (!(await stepUp({ action: `Reopen ${formatMonthKey(p.month)}`, detail: reason }))) return;
                        await reopen.mutateAsync({ month: p.month, reason });
                        toast.warning(`${formatMonthKey(p.month)} reopened`, { description: "The CEO / Founder / Owner is notified. Close it again when the fix is posted." });
                      }}
                    >
                      <LockOpen /> Reopen
                    </Button>
                  </TD>
                )}
              </TR>
            );
          })}
        </TBody>
      </Table>
      <p className="flex items-center gap-2 border-t border-border px-5 py-3 text-[12px] text-muted-foreground">
        <RotateCcw className="size-3.5" /> Statements of closed months never change; they are saved as fixed snapshots.
      </p>
    </Card>
  );
}
