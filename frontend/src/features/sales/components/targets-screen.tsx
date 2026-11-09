"use client";
import * as React from "react";
import { toast } from "sonner";
import { Ban, Check, Coins, Info, Pencil, Plus, Save, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Skeleton, Table, TBody, TD, TH, THead, TR } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { MakerCheckerNote } from "@/components/shared/approval-relay";
import { RequireAccess } from "@/components/shared/can";
import { StatusBadge, statusMap } from "@/components/shared/chips";
import { DataTable, type Column } from "@/components/shared/data-table";
import { useReason } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { Money } from "@/components/shared/money";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatMonthKey } from "@/lib/dates";
import type { CommissionRow } from "../api";
import { useAddDnc, useApproveCommission, useCommission, useDnc, useRejectCommission, useSaveTargets, useTargets, useUpdateCommissionRule } from "../hooks";
import type { CommissionStatus, DailyTargets, DncEntry, MonthlyTargets } from "../types";

type Tab = "targets" | "commission" | "dnc";

export function TargetsScreen() {
  return (
    <RequireAccess permission={["sales.targets", "sales.commission_view", "sales.commission_approve", "sales.own"]}>
      <TargetsInner />
    </RequireAccess>
  );
}

function TargetsInner() {
  const viewer = useViewer();
  const canTargets = !!viewer?.can(["sales.targets", "sales.own"]);
  const canCommission = !!viewer?.can(["sales.commission_view", "sales.commission_approve"]);
  const canDnc = !!viewer?.can("sales.own");
  const first: Tab = canTargets ? "targets" : canCommission ? "commission" : "dnc";
  const [tab, setTab] = useUrlState<Tab>("tab", first);
  const financeOnly = canCommission && !viewer?.can("sales.own");

  return (
    <>
      <PageHeader
        title="Targets and commission"
        description={financeOnly ? "Won deal values and commission lines. You see these for payroll; leads and pipeline stay with the sales team." : "Daily and monthly targets, commission on first payments, and the do-not-contact list."}
        seal="confidential"
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {canTargets && <TabsTrigger value="targets">Targets</TabsTrigger>}
          {canCommission && <TabsTrigger value="commission">Commission</TabsTrigger>}
          {canDnc && <TabsTrigger value="dnc">Do not contact</TabsTrigger>}
        </TabsList>
        {canTargets && (
          <TabsContent value="targets">
            <TargetsTab editable={!!viewer?.can("sales.targets")} />
          </TabsContent>
        )}
        {canCommission && (
          <TabsContent value="commission">
            <CommissionTab canApprove={!!viewer?.can("sales.commission_approve")} me={viewer?.employee.empId ?? ""} />
          </TabsContent>
        )}
        {canDnc && (
          <TabsContent value="dnc">
            <DncTab />
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}

/* ---------------- Targets ---------------- */

const DAILY_FIELDS: { key: keyof Omit<DailyTargets, "empId">; label: string }[] = [
  { key: "leadsAdded", label: "Leads added" },
  { key: "emailsChecked", label: "Emails checked" },
  { key: "emailsSent", label: "Emails sent" },
  { key: "followUps", label: "Follow-ups" },
];

function NumInput({ value, onChange, disabled, label }: { value: number; onChange: (n: number) => void; disabled: boolean; label: string }) {
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, "") || 0))}
      className="h-8 w-20 rounded-md border border-input bg-card px-2 text-right font-mono text-[13px] tabular outline-none focus:border-ring disabled:border-transparent disabled:bg-transparent"
    />
  );
}

function TargetsTab({ editable }: { editable: boolean }) {
  const q = useTargets();
  if (q.isPending) return <Skeleton className="h-64" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data.daily.length) return <EmptyState title="No targets set" description="Targets are set for people with daily sales work." />;
  // Re-key on new data so the editor starts from the saved values after every save.
  return <TargetsEditor key={q.dataUpdatedAt} saved={q.data} editable={editable} />;
}

function TargetsEditor({ saved, editable }: { saved: { daily: DailyTargets[]; monthly: MonthlyTargets[] }; editable: boolean }) {
  const save = useSaveTargets();
  const [daily, setDaily] = React.useState<DailyTargets[]>(() => structuredClone(saved.daily));
  const [monthly, setMonthly] = React.useState<MonthlyTargets[]>(() => structuredClone(saved.monthly));
  const dirty = JSON.stringify(daily) !== JSON.stringify(saved.daily) || JSON.stringify(monthly) !== JSON.stringify(saved.monthly);

  return (
    <div className="grid gap-5">
      {!editable && (
        <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Info className="size-4" /> The sales manager sets targets. Ask them if a target looks wrong.
        </p>
      )}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Daily targets</CardTitle>
            <p className="text-[12.5px] text-muted-foreground">For every working day. Met targets count toward Activity (V) on the sales scorecard.</p>
          </div>
        </CardHeader>
        <Table>
          <THead>
            <tr>
              <TH>Salesperson</TH>
              {DAILY_FIELDS.map((f) => (
                <TH key={f.key} className="text-right">
                  {f.label}
                </TH>
              ))}
            </tr>
          </THead>
          <TBody>
            {daily.map((t, i) => (
              <TR key={t.empId}>
                <TD>
                  <EmpChip empId={t.empId} size="sm" />
                </TD>
                {DAILY_FIELDS.map((f) => (
                  <TD key={f.key} className="text-right">
                    <NumInput label={`${f.label} for ${t.empId}`} value={t[f.key]} disabled={!editable} onChange={(n) => setDaily((d) => d.map((x, j) => (j === i ? { ...x, [f.key]: n } : x)))} />
                  </TD>
                ))}
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Monthly targets · {monthly[0] ? formatMonthKey(monthly[0].month) : ""}</CardTitle>
            <p className="text-[12.5px] text-muted-foreground">Meetings (M) and deals won value (W) on the sales scorecard.</p>
          </div>
        </CardHeader>
        <Table>
          <THead>
            <tr>
              <TH>Salesperson</TH>
              <TH className="text-right">Meetings booked</TH>
              <TH className="text-right">Proposals sent</TH>
              <TH className="text-right">Deals won (USD)</TH>
            </tr>
          </THead>
          <TBody>
            {monthly.map((t, i) => (
              <TR key={t.empId}>
                <TD>
                  <EmpChip empId={t.empId} size="sm" />
                </TD>
                <TD className="text-right">
                  <NumInput label="Meetings" value={t.meetings} disabled={!editable} onChange={(n) => setMonthly((m) => m.map((x, j) => (j === i ? { ...x, meetings: n } : x)))} />
                </TD>
                <TD className="text-right">
                  <NumInput label="Proposals" value={t.proposals} disabled={!editable} onChange={(n) => setMonthly((m) => m.map((x, j) => (j === i ? { ...x, proposals: n } : x)))} />
                </TD>
                <TD className="text-right">
                  <NumInput
                    label="Won value"
                    value={Math.round(Number(t.wonValue.amount))}
                    disabled={!editable}
                    onChange={(n) => setMonthly((m) => m.map((x, j) => (j === i ? { ...x, wonValue: { amount: n.toFixed(2), currency: "USD" } } : x)))}
                  />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      {editable && (
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={!dirty}
            onClick={() => {
              setDaily(structuredClone(saved.daily));
              setMonthly(structuredClone(saved.monthly));
            }}
          >
            Discard changes
          </Button>
          <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate({ daily, monthly }, { onSuccess: () => toast.success("Targets saved", { description: "They apply from tomorrow's report. The change is logged." }) })}>
            <Save /> Save targets
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------------- Commission ---------------- */

const commissionStatus = statusMap<CommissionStatus>({
  calculated: { label: "Waiting for the Director", tone: "warning" },
  approved: { label: "Approved", tone: "info" },
  sent_to_payroll: { label: "Sent to payroll", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
});

function CommissionTab({ canApprove, me }: { canApprove: boolean; me: string }) {
  const q = useCommission();
  const approve = useApproveCommission();
  const reject = useRejectCommission();
  const askReason = useReason();
  const [ruleOpen, setRuleOpen] = React.useState(false);
  const rule = q.data?.rules.find((r) => r.active);

  const columns: Column<CommissionRow>[] = [
    { key: "deal", header: "Deal", sortValue: (c) => c.dealNumber, cell: (c) => <span className="grid min-w-36"><span className="font-medium">{c.companyName}</span><span className="font-mono text-[11.5px] text-muted-foreground">{c.dealNumber}</span></span> },
    { key: "person", header: "Salesperson", cell: (c) => <EmpChip empId={c.empId} size="sm" showId={false} /> },
    { key: "invoice", header: "First payment", cell: (c) => <span className="grid"><span className="whitespace-nowrap font-mono text-[12.5px]">{c.invoiceNumber}</span><span className="whitespace-nowrap text-[11.5px] text-muted-foreground">Paid {formatDate(c.invoicePaidAt)}</span></span>, hideOnMobile: true },
    { key: "won", header: "Deal value", align: "right", cell: (c) => (c.dealValue ? <Money value={c.dealValue} /> : "—"), hideOnMobile: true },
    { key: "base", header: "Base", align: "right", cell: (c) => <Money value={c.base} /> },
    { key: "amount", header: "Commission", align: "right", sortValue: (c) => Number(c.amount.amount), cell: (c) => <span className="grid justify-items-end"><Money value={c.amount} className="font-semibold" /><span className="text-[11px] text-muted-foreground">{c.ratePercent}%</span></span> },
    { key: "status", header: "Status", cell: (c) => <span className="grid justify-items-start gap-0.5"><StatusBadge {...commissionStatus(c.status)} />{c.payrollMonth && c.status === "sent_to_payroll" && <span className="text-[11px] text-muted-foreground">{formatMonthKey(c.payrollMonth)} payroll</span>}{c.rejectReason && <span className="text-[11px] text-muted-foreground">{c.rejectReason}</span>}</span> },
    ...(canApprove
      ? [
          {
            key: "actions",
            header: "",
            align: "right" as const,
            cell: (c: CommissionRow) =>
              c.status !== "calculated" ? null : c.empId === me ? (
                <span className="text-[11.5px] text-muted-foreground">Goes to the CEO</span>
              ) : (
                <span className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const reason = await askReason({ title: "Reject commission", confirmLabel: "Reject", destructive: true });
                      if (reason) reject.mutate({ id: c.id, reason }, { onSuccess: () => toast("Commission rejected") });
                    }}
                  >
                    <X /> Reject
                  </Button>
                  <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate(c.id, { onSuccess: () => toast.success("Approved and sent to payroll", { description: "Added to this month's payroll as a bonus line." }) })}>
                    <Check /> Approve
                  </Button>
                </span>
              ),
          },
        ]
      : []),
  ];

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="grid size-10 place-content-center rounded-xl bg-zone-sales/14 text-zone-sales">
              <Coins className="size-5" />
            </span>
            <div>
              <CardTitle>{rule?.name ?? "Commission rule"}</CardTitle>
              <p className="text-[12.5px] text-muted-foreground">
                {rule ? (
                  <>
                    <span className="font-semibold text-foreground">{rule.ratePercent}%</span> of the client&apos;s first payment, calculated when the first invoice is paid, approved by the Director and added
                    to payroll as a bonus line. Effective {formatDate(rule.effectiveFrom)}.
                  </>
                ) : (
                  "Loading…"
                )}
              </p>
            </div>
          </div>
          {canApprove && rule && (
            <Button size="sm" variant="outline" onClick={() => setRuleOpen(true)}>
              <Pencil /> Change rate
            </Button>
          )}
        </CardHeader>
      </Card>
      {!canApprove && <MakerCheckerNote reason="Commission lines are approved by the Director. You can see the won values and lines for payroll." />}
      <DataTable rows={q.data?.lines} loading={q.isPending} columns={columns} rowKey={(c) => c.id} initialSort={{ key: "deal", dir: "desc" }} empty={<EmptyState compact icon={<Coins />} title="No commission yet" description="A line appears when a client pays their first invoice." />} />
      {rule && ruleOpen && <RuleDialog open onOpenChange={setRuleOpen} id={rule.id} rate={rule.ratePercent} />}
    </div>
  );
}

function RuleDialog({ open, onOpenChange, id, rate }: { open: boolean; onOpenChange: (o: boolean) => void; id: string; rate: number }) {
  // Mounted only while open (see CommissionTab), so state starts from the current rate.
  const [value, setValue] = React.useState(String(rate));
  const [reason, setReason] = React.useState("");
  const update = useUpdateCommissionRule();
  const n = Number(value);
  const valid = n > 0 && n <= 30 && reason.trim().length >= 3;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Change commission rate</DialogTitle>
          <DialogDescription>Applies to first payments from today. Lines already calculated keep their rate.</DialogDescription>
        </DialogHeader>
        <Field label="Rate (% of first payment)" htmlFor="cr-rate">
          <Input id="cr-rate" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className="w-28 font-mono" />
        </Field>
        <Field label="Reason" htmlFor="cr-reason" hint="Saved in the audit log.">
          <Textarea id="cr-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={update.isPending} onClick={() => update.mutate({ id, ratePercent: n }, { onSuccess: () => { toast.success("Commission rate changed"); onOpenChange(false); } })}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Do not contact ---------------- */

function DncTab() {
  const q = useDnc();
  const add = useAddDnc();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [reason, setReason] = React.useState("");
  const columns: Column<DncEntry>[] = [
    { key: "email", header: "Email", sortValue: (d) => d.email, cell: (d) => <span className="flex items-center gap-2 font-mono text-[12.5px]"><Ban className="size-3.5 text-danger" />{d.email}</span> },
    { key: "lead", header: "Lead", cell: (d) => (d.leadId ? <Badge tone="outline">Linked to a lead</Badge> : <span className="text-muted-foreground">—</span>), hideOnMobile: true },
    { key: "reason", header: "Reason", cell: (d) => <span className="text-[12.5px]">{d.reason}</span> },
    { key: "by", header: "Added by", cell: (d) => <EmpChip empId={d.addedBy} size="sm" showId={false} />, hideOnMobile: true },
    { key: "at", header: "Date", align: "right", sortValue: (d) => d.at, cell: (d) => <span className="text-[12.5px] text-muted-foreground">{formatDate(d.at)}</span> },
  ];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[12.5px] text-muted-foreground">
          Emails on this list are blocked from every future sequence. Every outreach email carries an unsubscribe link and Aceva&apos;s postal address (UK GDPR and US CAN-SPAM).
        </p>
        <Button onClick={() => setOpen(true)}>
          <Plus /> Add email
        </Button>
      </div>
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <DataTable rows={q.data} loading={q.isPending} columns={columns} rowKey={(d) => d.id} searchable searchText={(d) => `${d.email} ${d.reason}`} searchPlaceholder="Search emails" initialSort={{ key: "at", dir: "desc" }} />}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Add to do not contact</DialogTitle>
            <DialogDescription>The email is blocked from sequences straight away. A matching lead is marked too.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate(
                { email, reason },
                {
                  onSuccess: () => {
                    toast.success("Added to do not contact");
                    setOpen(false);
                    setEmail("");
                    setReason("");
                  },
                  onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't add the email."),
                },
              );
            }}
          >
            <Field label="Email" htmlFor="dnc-email" required>
              <Input id="dnc-email" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Reason" htmlFor="dnc-reason" required>
              <Input id="dnc-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: unsubscribed by reply" />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!email || reason.trim().length < 3} loading={add.isPending}>
                Add
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
