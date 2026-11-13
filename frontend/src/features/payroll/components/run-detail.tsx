"use client";
import * as React from "react";
import { toast } from "sonner";
import { BookOpen, CircleCheck, FileSpreadsheet, Landmark, Lock, Send, Undo2, CornerDownLeft, Calculator, ClipboardCheck, Eye, TriangleAlert } from "lucide-react";
import { PageHeader, SectionTitle } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/misc";
import { ApprovalRelay, MakerCheckerNote } from "@/components/shared/approval-relay";
import { RequireAccess } from "@/components/shared/can";
import { useExport, useReason, useStepUp } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { StatCard } from "@/components/shared/metrics";
import { Money, Mono } from "@/components/shared/money";
import { ErrorState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { isLive } from "@/lib/api/http";
import { useViewer } from "@/lib/auth/viewer";
import { formatDateTime, formatMonthKey, isoDay } from "@/lib/dates";
import { formatMoney, toNumber } from "@/lib/format";
import type { RunAction } from "../api";
import { useAdjustments, useBankAccounts, useBankSheet, useCanPreparePayroll, usePayrollRun, useRunAction } from "../hooks";
import { isLocked, journalPreview, nextMonthKey, PAYROLL_REVIEWER, stageIndex } from "../logic";
import type { LedgerEntryRef, PayrollLine, PayrollRun } from "../types";

const LIVE = isLive("m8");

const ENTRY_STATUS: Record<LedgerEntryRef["status"], { label: string; tone: "neutral" | "warning" | "success" | "danger" }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending_approval: { label: "Waiting for ledger approval", tone: "warning" },
  posted: { label: "Posted", tone: "success" },
  rejected: { label: "Rejected in the ledger", tone: "danger" },
};
import { RunLinesTable } from "./run-lines-table";
import { StageBadge, StagePipeline } from "./stage-pipeline";

export function RunDetail({ id }: { id: string }) {
  return (
    <RequireAccess permission="payroll.view" mode="404">
      <RunDetailInner id={id} />
    </RequireAccess>
  );
}

function JournalCard({ run, lines }: { run: PayrollRun; lines: PayrollLine[] }) {
  const rows = journalPreview(lines);
  const posted = !!run.journalEntryNumber;
  const total = rows.reduce((s, r) => s + toNumber(r.debit), 0);
  const entry = run.salaryEntry ? ENTRY_STATUS[run.salaryEntry.status] : null;
  const description = LIVE
    ? run.salaryEntry
      ? `Created on approval as ${run.salaryEntry.number}. Like every system entry it goes through the normal ledger approval before it is posted.`
      : "Created automatically when the CEO approves the run; it then waits for the normal ledger approval."
    : posted
      ? `Posted as ${run.journalEntryNumber}${run.postedAt ? ` on ${formatDateTime(run.postedAt)}` : ""}.`
      : "Posted to the ledger after payslips are sent. Statements update on their own.";
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="size-4 text-zone-finance" /> Ledger entry
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {LIVE ? entry && <Badge tone={entry.tone}>{entry.label}</Badge> : posted && <Badge tone="success">Posted</Badge>}
      </CardHeader>
      <CardContent>
        <JournalTable rows={rows} total={total} />
        {run.paymentEntryNumber && (
          <p className="mt-3 text-[12.5px] text-muted-foreground">
            Bank transfer recorded as <Mono>{run.paymentEntryNumber}</Mono>: Dr Salary payable / Cr Bank
            {run.paymentEntry ? ` (${ENTRY_STATUS[run.paymentEntry.status].label.toLowerCase()})` : ""}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function JournalTable({ rows, total }: { rows: ReturnType<typeof journalPreview>; total: number }) {
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
          <th className="py-1.5">Account</th>
          <th className="py-1.5 text-right">Debit</th>
          <th className="py-1.5 text-right">Credit</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.code} className="border-b border-dashed border-border">
            <td className="py-1.5">
              <Mono className="text-muted-foreground">{r.code}</Mono> {r.account}
            </td>
            <td className="py-1.5 text-right">{toNumber(r.debit) ? <Money value={r.debit} exact /> : ""}</td>
            <td className="py-1.5 text-right">{toNumber(r.credit) ? <Money value={r.credit} exact /> : ""}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="font-semibold">
          <td className="pt-2">Totals (balanced)</td>
          <td className="pt-2 text-right">
            <Money value={total} exact />
          </td>
          <td className="pt-2 text-right">
            <Money value={total} exact />
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function RunDetailInner({ id }: { id: string }) {
  const q = usePayrollRun(id);
  const adjustments = useAdjustments();
  const viewer = useViewer();
  const lookup = useLookup();
  const act = useRunAction();
  const stepUp = useStepUp();
  const askReason = useReason();
  const exportData = useExport();
  const canPrepare = useCanPreparePayroll();
  const bankSheet = useBankSheet();
  const [postOpen, setPostOpen] = React.useState(false);
  const [payOpen, setPayOpen] = React.useState(false);

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isPending || !viewer)
    return (
      <div className="grid gap-4 pt-6">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );

  const { run, lines } = q.data;
  const me = viewer.employee.empId;
  const isMaker = run.preparedBy === me;
  const canReview = viewer.can("payroll.review");
  const canApprove = viewer.can("payroll.approve");
  // Oversight only (the Owner): sees every run, acts on none.
  const viewOnly = !canPrepare && !canApprove && !canReview;
  const name = (empId?: string) => lookup.employee(empId)?.name ?? empId ?? "—";
  const monthName = formatMonthKey(run.month);
  const carried = (adjustments.data ?? []).filter((a) => a.toMonth === run.month);
  const other = lines.reduce((s, l) => s + toNumber(l.otherDeductions), 0);

  const run_ = (action: RunAction, success: string, note?: string, extra: { bankAccountId?: string; paidOn?: string } = {}) =>
    act.mutateAsync({ id: run.id, action, note, ...extra }).then(
      () => toast.success(success, { description: "Saved and logged." }),
      (e: Error) => toast.error(e.message),
    );

  const sendBack = async () => {
    const reason = await askReason({ title: `Send ${monthName} payroll back`, description: "Finance fixes it and prepares it again. Your reason is saved with the run.", confirmLabel: "Send back", destructive: true });
    if (reason) run_("return", "Sent back to Finance", reason);
  };

  const approve = async () => {
    const ok = await stepUp({ action: `Approve ${monthName} payroll`, detail: `${run.headcount} people · net ${formatMoney(run.totals.net)}` });
    if (ok) run_("approve", `${monthName} payroll approved`, undefined);
  };

  const exportSheet = async () => {
    if (!LIVE) {
      exportData({ title: `bank transfer sheet · ${monthName}`, seal: "highly", stepUp: true, formats: ["xlsx", "csv"], rows: lines.length });
      return;
    }
    // Live: the server needs a fresh confirmation, sends a CSV marked highly confidential and logs the export.
    const ok = await stepUp({ action: `Export the ${monthName} bank transfer sheet`, detail: `${run.headcount} full account numbers · highly confidential` });
    if (!ok) return;
    bankSheet.mutateAsync(run.id).then(
      () => toast.success("Bank transfer sheet downloaded", { description: "Highly confidential. The export is logged." }),
      (e: Error) => toast.error(e.message),
    );
  };

  // What the viewer can do now.
  let action: React.ReactNode = null;
  switch (run.stage) {
    case "draft":
      action = canPrepare ? (
        <Button onClick={() => run_("calculate", "Attendance locked and salaries calculated")} loading={act.isPending}>
          <Calculator /> Lock attendance and calculate
        </Button>
      ) : null;
      break;
    case "calculated":
      action = canPrepare ? (
        <Button onClick={() => run_("prepare", "Prepared and sent to the Director for review")} loading={act.isPending}>
          <ClipboardCheck /> Mark prepared and send for review
        </Button>
      ) : null;
      break;
    case "prepared":
      action =
        canReview && !isMaker ? (
          <>
            <Button variant="outline" onClick={sendBack}>
              <Undo2 /> Send back
            </Button>
            <Button onClick={() => run_("review", "Reviewed and sent to the CEO for approval")} loading={act.isPending}>
              <Eye /> Mark reviewed
            </Button>
          </>
        ) : null;
      break;
    case "reviewed":
      action =
        canApprove && !isMaker ? (
          <>
            <Button variant="outline" onClick={sendBack}>
              <Undo2 /> Send back
            </Button>
            <Button onClick={approve} loading={act.isPending}>
              <Lock /> Approve payroll
            </Button>
          </>
        ) : null;
      break;
    case "approved":
      action = canPrepare && !LIVE ? (
        <Button onClick={() => run_("send_payslips", "Payslips created and employees notified")} loading={act.isPending}>
          <Send /> Send payslips
        </Button>
      ) : null;
      break;
    case "payslips_sent":
      action = !canPrepare ? null : LIVE ? (
        <Button onClick={() => setPayOpen(true)}>
          <Landmark /> Mark bank transfer done
        </Button>
      ) : (
        <Button onClick={() => setPostOpen(true)}>
          <BookOpen /> Post to ledger
        </Button>
      );
      break;
    case "posted":
      action = canPrepare ? (
        <Button onClick={() => (LIVE ? setPayOpen(true) : run_("mark_paid", "Bank transfer recorded. Salary payable cleared."))} loading={act.isPending}>
          <Landmark /> Mark bank transfer done
        </Button>
      ) : null;
      break;
  }

  const waitingFor: Record<string, string> = {
    draft: "Finance to lock attendance",
    calculated: "Finance to prepare it",
    prepared: `${name(run.chain[1]?.empId ?? PAYROLL_REVIEWER)} (Director) to review`,
    reviewed: "the CEO to approve",
    approved: "Finance to send payslips",
    payslips_sent: "Finance to post it",
    posted: "Finance to record the bank transfer",
  };
  // Live: the server says what happens next.
  const waitingText = LIVE && run.next ? `${run.next.label}.` : `Waiting for ${waitingFor[run.stage]}.`;

  return (
    <>
      <PageHeader
        back={{ href: "/payroll", label: "Payroll" }}
        title={`${monthName} payroll`}
        description={`${run.headcount} people · ${run.workingDays} working days${run.attendanceLockedAt ? ` · attendance locked ${formatDateTime(run.attendanceLockedAt)}` : " · attendance still open"}`}
        seal="highly"
        meta={
          <>
            <Mono className="text-[12.5px] text-muted-foreground">{run.number}</Mono>
            <StageBadge stage={run.stage} />
            {isLocked(run.stage) && (
              <Badge tone="outline">
                <Lock /> Read-only
              </Badge>
            )}
          </>
        }
        actions={
          stageIndex(run.stage) >= stageIndex("approved") &&
          viewer.can("payroll.export") && (
            <Button variant="outline" onClick={exportSheet}>
              <FileSpreadsheet /> Bank transfer sheet
            </Button>
          )
        }
      />

      <div className="grid gap-6">
        <Card>
          <CardContent className="grid gap-5 pt-5">
            <StagePipeline stage={run.stage} />
            {run.returnedNote && run.stage === "calculated" && (
              <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/12 px-3 py-2 text-[13px]">
                <CornerDownLeft className="mt-0.5 size-4 shrink-0" />
                <span>
                  <span className="font-medium">Sent back:</span> “{run.returnedNote}”
                </span>
              </p>
            )}
            <div className="flex flex-wrap items-end justify-between gap-4">
              <ApprovalRelay steps={run.chain} />
              <div className="flex flex-wrap items-center gap-2">
                {action ??
                  (run.stage === "paid" ? (
                    <p className="flex items-center gap-2 text-[13px] text-success">
                      <CircleCheck className="size-4" /> Paid and posted. This run is closed.
                    </p>
                  ) : isMaker && (run.stage === "prepared" || run.stage === "reviewed") ? null : (
                    <p className="text-[13px] text-muted-foreground">{waitingText}</p>
                  ))}
              </div>
            </div>
            {isMaker && (run.stage === "prepared" || run.stage === "reviewed") && (
              <MakerCheckerNote reason="You prepared this payroll, so you can't review or approve it. The Director reviews it and the CEO approves it." />
            )}
            {viewOnly && run.stage !== "paid" && <MakerCheckerNote reason="View only. Finance prepares payroll, the Director reviews it and the CEO approves it." />}
            {LIVE && (run.missingPay?.length || run.pendingAdjustments) && !isLocked(run.stage) ? (
              <div className="grid gap-1 rounded-lg border border-warning/40 bg-warning/12 px-3 py-2 text-[13px]">
                {!!run.missingPay?.length && (
                  <p className="flex items-start gap-2">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>
                      Not in this run because no pay is on file: {run.missingPay.map((p) => `${p.name} (${p.empId})`).join(", ")}.
                    </span>
                  </p>
                )}
                {!!run.pendingAdjustments && (
                  <p className="flex items-start gap-2">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>{run.pendingAdjustments} adjustment(s) for this month are not in the lines yet. Calculate again before preparing.</span>
                  </p>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Gross pay" value={<Money value={run.totals.gross} compact />} hint="After unpaid leave" accent="var(--zone-finance)" />
          <StatCard label="Income tax" value={<Money value={run.totals.tax} compact />} hint="Withheld for FBR" accent="var(--zone-finance)" />
          <StatCard label="Other deductions" value={<Money value={other} compact />} hint="Advance repayments and deduction lines" accent="var(--zone-finance)" />
          <StatCard label="Net pay" value={<Money value={run.totals.net} compact />} hint={`${run.headcount} bank transfers`} accent="var(--zone-finance)" />
        </div>

        <section>
          <SectionTitle title="Salaries" description="Open a row to see the calculation. Changes of more than 10% from last month are flagged." />
          <RunLinesTable run={run} lines={lines} />
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <JournalCard run={run} lines={lines} />
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Adjustments</CardTitle>
                <CardDescription>Fixes found after an earlier run was approved are carried into this month.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {carried.length ? (
                <ul className="grid gap-2">
                  {carried.map((a) => (
                    <li key={a.id} className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2">
                      <div className="grid gap-1">
                        <EmpChip empId={a.empId} size="sm" />
                        <p className="text-[12.5px] text-muted-foreground">
                          {a.note} · added by {name(a.createdBy)}
                        </p>
                      </div>
                      <Money value={a.amount} sign tone="auto" className="text-[13px] font-semibold" />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  No adjustments carried into {monthName}.{isLocked(run.stage) ? ` Fixes to this run go into ${formatMonthKey(nextMonthKey(run.month))}.` : ""}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {LIVE && <MarkPaidDialog open={payOpen} onOpenChange={setPayOpen} run={run} onDone={() => setPayOpen(false)} />}

      <Dialog open={postOpen} onOpenChange={setPostOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Post {monthName} payroll to the ledger</DialogTitle>
            <DialogDescription>This entry is posted once and can&apos;t be edited. Mistakes are fixed with an adjustment next month.</DialogDescription>
          </DialogHeader>
          <JournalTable rows={journalPreview(lines)} total={journalPreview(lines).reduce((s, r) => s + toNumber(r.debit), 0)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPostOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={act.isPending}
              onClick={async () => {
                await run_("post", "Posted to the ledger");
                setPostOpen(false);
              }}
            >
              Post entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Live: record the bank transfer. The server creates the payment entry (Dr salary payable / Cr the bank), once per run. */
function MarkPaidDialog({ open, onOpenChange, run, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; run: PayrollRun; onDone: () => void }) {
  const banks = useBankAccounts(open);
  const act = useRunAction();
  const [bankAccountId, setBankAccountId] = React.useState("");
  const [paidOn, setPaidOn] = React.useState(isoDay(new Date()));
  const chosen = bankAccountId || banks.data?.[0]?.id || "";
  const save = () =>
    act.mutateAsync({ id: run.id, action: "mark_paid", bankAccountId: chosen, paidOn }).then(
      () => {
        toast.success("Bank transfer recorded", { description: "The payment entry waits for the ledger approval." });
        onDone();
      },
      (e: Error) => toast.error(e.message),
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Record the {formatMonthKey(run.month)} bank transfer</DialogTitle>
          <DialogDescription>Creates the payment entry that clears salary payable ({formatMoney(run.totals.net)}). It can be recorded once.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Paid from" htmlFor="pay-bank">
            <NativeSelect id="pay-bank" value={chosen} onChange={(e) => setBankAccountId(e.target.value)} disabled={banks.isPending}>
              {(banks.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} · {b.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Transfer date" htmlFor="pay-date">
            <Input id="pay-date" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!chosen || !paidOn} loading={act.isPending}>
            Record transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
