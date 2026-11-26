"use client";

/**
 * Module 15.7 in live mode: the Commission tab (approved scope). The server decides which lines the viewer sees (own,
 * team or all) and what they may do on each (`can`); the screen shows that and asks for a reason, and for a fresh
 * password confirmation where the server requires it (the Owner's decisions, and the rule). Nothing here is calculated
 * in the browser: amounts, rates and statuses are the server's.
 */
import * as React from "react";
import { toast } from "sonner";
import { Check, Coins, Gavel, Pause, Pencil, X } from "lucide-react";
import { SALES_COMMISSION_STATUSES, SALES_COMMISSION_STATUS_LABEL, type SalesCommissionLineView } from "@aceva/contracts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/shared/chips";
import { DataTable, type Column } from "@/components/shared/data-table";
import { useReason, useStepUp } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { StatCard } from "@/components/shared/metrics";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { useViewer } from "@/lib/auth/viewer";
import { isoDay } from "@/lib/dates";
import { collectedText, COMMISSION_STATUS_TONE, commissionAmountText, commissionStatusText, waitingFor } from "../commission-live";
import {
  useApproveCommissionLine,
  useCommissionLeaverDecision,
  useHoldCommissionLine,
  useLiveCommission,
  useLiveCommissionRules,
  useRejectCommissionLine,
  useSetCommissionRule,
} from "../hooks";
import { money } from "../performance-live";

const SCOPE_TEXT = {
  own: "Your own commission lines.",
  team: "The commission lines of your sales team.",
  all: "Every commission line.",
} as const;

const failed = (e: unknown) => toast.error(e instanceof Error ? e.message : "That didn't work. Reload and try again.");

export function LiveCommissionTab() {
  const viewer = useViewer();
  const me = viewer?.employee.empId ?? "";
  const isDirector = !!viewer?.can("sales.commission_approve");
  const isOwnerApprover = !!viewer?.can("sales.commission_approve_director");
  const q = useLiveCommission();
  const rules = useLiveCommissionRules(isDirector || isOwnerApprover);
  const approve = useApproveCommissionLine();
  const reject = useRejectCommissionLine();
  const hold = useHoldCommissionLine();
  const leaver = useCommissionLeaverDecision();
  const askReason = useReason();
  const stepUp = useStepUp();
  const [ruleOpen, setRuleOpen] = React.useState(false);
  // The Owner decides without the Director's permission: the server then asks for a fresh confirmation.
  const ownersDecision = !isDirector && isOwnerApprover;

  const onApprove = async (l: SalesCommissionLineView) => {
    let reason: string | undefined;
    if (ownersDecision) {
      const r = await askReason({ title: `Approve the Director's commission on ${l.dealNumber}`, description: "Your reason is kept with the line and in the audit log.", confirmLabel: "Approve" });
      if (!r) return;
      reason = r;
      if (!(await stepUp({ action: `Approve the commission on ${l.dealNumber}`, detail: "The Director's own commission" }))) return;
    }
    approve.mutate({ id: l.id, version: l.version, reason }, { onSuccess: () => toast.success("Commission approved", { description: "Module 8 takes it into the next editable payroll run." }), onError: failed });
  };
  const onReject = async (l: SalesCommissionLineView) => {
    const reason = await askReason({ title: `Reject the commission on ${l.dealNumber}`, description: "The earner is told, and the reason is kept with the line and in the audit log.", confirmLabel: "Reject", destructive: true });
    if (!reason) return;
    if (ownersDecision && !(await stepUp({ action: `Reject the commission on ${l.dealNumber}` }))) return;
    reject.mutate({ id: l.id, reason, version: l.version }, { onSuccess: () => toast("Commission rejected"), onError: failed });
  };
  const onHold = async (l: SalesCommissionLineView) => {
    const reason = await askReason({ title: `Put the commission on ${l.dealNumber} on hold`, description: "For example after a refund or a payment reversal. The earner is told.", confirmLabel: "Put on hold" });
    if (!reason) return;
    hold.mutate({ id: l.id, reason, version: l.version }, { onSuccess: () => toast("Commission on hold"), onError: failed });
  };
  const onLeaver = async (l: SalesCommissionLineView, decision: "pay" | "forfeit") => {
    const reason = await askReason({
      title: decision === "pay" ? "Pay this commission (final settlement)" : "Do not pay this commission",
      description: `${l.earner.name} left before the invoice was fully paid. Your decision is final and kept with the line.`,
      confirmLabel: decision === "pay" ? "Pay" : "Do not pay",
      destructive: decision === "forfeit",
    });
    if (!reason) return;
    if (!(await stepUp({ action: `Final-settlement decision on ${l.dealNumber}` }))) return;
    leaver.mutate({ id: l.id, decision, reason, version: l.version }, { onSuccess: () => toast.success("Decision recorded"), onError: failed });
  };

  const columns: Column<SalesCommissionLineView>[] = [
    {
      key: "deal",
      header: "Deal",
      sortValue: (l) => l.dealNumber,
      cell: (l) => (
        <span className="grid min-w-36">
          <span className="font-medium">{l.companyName}</span>
          <span className="font-mono text-[11.5px] text-muted-foreground">{l.dealNumber}</span>
        </span>
      ),
    },
    { key: "earner", header: "Earner", cell: (l) => <EmpChip empId={l.earner.empId} size="sm" showId={false} /> },
    {
      key: "invoice",
      header: "Invoice paid",
      cell: (l) => (
        <span className="grid">
          <span className="whitespace-nowrap font-mono text-[12.5px]">{l.invoiceNumber}</span>
          <span className="whitespace-nowrap text-[11.5px] text-muted-foreground">{l.paidOn}</span>
        </span>
      ),
    },
    { key: "collected", header: "Collected", cell: (l) => <span className="text-[12.5px]">{collectedText(l)}</span>, hideOnMobile: true },
    { key: "rate", header: "Rate", align: "right", cell: (l) => (l.ratePercent ? <span title={`Rule version ${l.ruleVersion}`}>{l.ratePercent}%</span> : "—") },
    { key: "amount", header: "Commission", align: "right", sortValue: (l) => Number(l.amount ?? -1), cell: (l) => <span className={l.amount ? "font-semibold" : "text-muted-foreground"}>{commissionAmountText(l)}</span> },
    {
      key: "status",
      header: "Status",
      cell: (l) => (
        <span className="grid justify-items-start gap-0.5">
          <StatusBadge label={commissionStatusText(l)} tone={COMMISSION_STATUS_TONE[l.status]} />
          {l.approval && <span className="text-[11.5px] text-muted-foreground">Payroll {l.approval.payrollMonth}</span>}
          {l.hold?.note && <span className="max-w-56 text-[11.5px] text-muted-foreground">{l.hold.note}</span>}
          {l.rejection && <span className="max-w-56 text-[11.5px] text-muted-foreground">{l.rejection.reason}</span>}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (l) => {
        const note = waitingFor(l, l.earner.empId === me);
        if (note) return <span className="text-[11.5px] text-muted-foreground">{note}</span>;
        return (
          <span className="flex flex-wrap justify-end gap-1">
            {l.can.decideLeaver && (
              <>
                <Button size="sm" variant="ghost" onClick={() => onLeaver(l, "forfeit")}>
                  <X /> Do not pay
                </Button>
                <Button size="sm" loading={leaver.isPending} onClick={() => onLeaver(l, "pay")}>
                  <Gavel /> Pay
                </Button>
              </>
            )}
            {l.can.hold && (
              <Button size="sm" variant="ghost" onClick={() => onHold(l)}>
                <Pause /> Hold
              </Button>
            )}
            {l.can.reject && (
              <Button size="sm" variant="ghost" onClick={() => onReject(l)}>
                <X /> Reject
              </Button>
            )}
            {l.can.approve && (
              <Button size="sm" loading={approve.isPending} onClick={() => onApprove(l)}>
                <Check /> Approve
              </Button>
            )}
          </span>
        );
      },
    },
  ];

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const current = rules.data?.current;
  return (
    <div className="grid gap-5">
      {(isDirector || isOwnerApprover) && (
        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="grid size-10 place-content-center rounded-xl bg-zone-sales/14 text-zone-sales">
                <Coins className="size-5" />
              </span>
              <div>
                <CardTitle>Commission rule</CardTitle>
                <p className="text-[12.5px] text-muted-foreground">
                  {rules.isPending
                    ? "Loading…"
                    : current
                      ? `${current.ratePercent}% of what was collected on the deal's own invoice (in PKR at each payment's rate), from ${current.effectiveFrom}. Version ${current.version}.`
                      : "No rule yet: invoices paid since the baseline wait for a rate."}
                  {rules.data?.baselineDay ? ` Baseline: ${rules.data.baselineDay}; invoices fully paid (payment posted) before it get no commission.` : " The commission baseline is not recorded yet."}
                </p>
              </div>
            </div>
            {isDirector && !!rules.data?.baselineDay && (
              <Button size="sm" variant="outline" onClick={() => setRuleOpen(true)}>
                <Pencil /> {current ? "Change the rate" : "Set the rate"}
              </Button>
            )}
          </CardHeader>
          {!!rules.data?.versions.length && (
            <CardContent>
              <ul className="grid gap-1 text-[12.5px]">
                {rules.data.versions.map((v) => (
                  <li key={v.version} className="flex flex-wrap gap-x-2 text-muted-foreground">
                    <span className="font-medium text-foreground">v{v.version}</span>
                    <span>{v.ratePercent}% from {v.effectiveFrom}</span>
                    <span>· {v.setBy.name}</span>
                    <span>· {v.reason}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          )}
        </Card>
      )}
      {q.data && (
        <>
          <p className="text-[12.5px] text-muted-foreground">{SCOPE_TEXT[q.data.scope]} Commission is paid in PKR through payroll; the collected value stays in the invoice&apos;s currency.</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {SALES_COMMISSION_STATUSES.map((s) => {
              const t = q.data.totals.find((x) => x.status === s);
              return <StatCard key={s} label={SALES_COMMISSION_STATUS_LABEL[s]} value={String(t?.count ?? 0)} hint={t && s !== "waiting_rate" ? `PKR ${money(t.amount)}` : undefined} />;
            })}
          </div>
        </>
      )}
      <DataTable
        rows={q.data?.lines}
        loading={q.isPending}
        columns={columns}
        rowKey={(l) => l.id}
        initialSort={{ key: "deal", dir: "desc" }}
        empty={<EmptyState compact icon={<Coins />} title="No commission yet" description="A line appears when a Won deal's own invoice is fully paid." />}
      />
      {ruleOpen && rules.data?.baselineDay && <RuleDialog onClose={() => setRuleOpen(false)} baselineDay={rules.data.baselineDay} first={!rules.data.versions.length} />}
    </div>
  );
}

function RuleDialog({ onClose, baselineDay, first }: { onClose: () => void; baselineDay: string; first: boolean }) {
  const today = isoDay(new Date());
  const [rate, setRate] = React.useState("");
  // The first rule starts exactly on the baseline day (the server and the database insist); later ones today or later.
  const [from, setFrom] = React.useState(first ? baselineDay : today);
  const [reason, setReason] = React.useState("");
  const set = useSetCommissionRule();
  const stepUp = useStepUp();
  const n = Number(rate);
  const valid = /^\d{1,3}(\.\d{1,2})?$/.test(rate.trim()) && n > 0 && n <= 100 && reason.trim().length >= 5 && !!from;
  const save = async () => {
    if (!(await stepUp({ action: "Change the commission rule", detail: `${rate}% from ${from}` }))) return;
    set.mutate({ ratePercent: rate.trim(), effectiveFrom: from, reason: reason.trim() }, { onSuccess: () => { toast.success("Commission rule saved"); onClose(); }, onError: failed });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Commission rule</DialogTitle>
          <DialogDescription>A new version; earlier versions and lines already calculated never change.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Rate (percent)">
            <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="10" />
          </Field>
          <Field label="Effective from" hint={first ? `The first rule starts on the baseline day (${baselineDay}).` : "Today or later."}>
            <Input type="date" value={from} min={first ? baselineDay : today} max={first ? baselineDay : undefined} disabled={first} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Reason">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Approved by management" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={set.isPending} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
