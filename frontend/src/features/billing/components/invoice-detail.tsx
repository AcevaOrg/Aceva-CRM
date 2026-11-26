"use client";
import * as React from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Ban, BellOff, BookOpen, Check, Clock, Download, HandCoins, Mail, Printer, Repeat, RotateCcw, Send, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress, Skeleton } from "@/components/ui/misc";
import { PageHeader } from "@/components/layout/page-header";
import { Can, NotFoundBlock, RequireAccess } from "@/components/shared/can";
import { DeadlineChip } from "@/components/shared/chips";
import { useExport, useReason, useStepUp } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { Mono, Money } from "@/components/shared/money";
import { ErrorState } from "@/components/shared/states";
import { Timeline, type TimelineItem } from "@/components/shared/timeline";
import { isLive } from "@/lib/api/http";
import { ApiError } from "@/lib/api/mock";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime, isoDay } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { useBankAccounts, useCancelInvoice, useConfirmCustomer, useEmailInvoice, useInvoice, useRecordPayment, useRestoreInvoice, useSendInvoice, useStopRecurring } from "../hooks";
import { PAYMENT_METHOD, reminderLabel } from "../logic";
import type { Invoice, InvoiceDetail as InvoiceDetailData, PaymentMethod, ReminderEvent } from "../types";
import { InvoiceStatusBadge, InvoiceTypeLabel, ViewOnlyNote } from "./bits";
import { InvoicePreview } from "./invoice-preview";

/** Live (m13): the real server; the ledger entry of each invoice and payment waits for approval in Module 9. */
const LIVE = isLive("m13");
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/v1";

const ENTRY_STATUS: Record<string, string> = { draft: "draft", pending_approval: "waiting for approval", posted: "posted", rejected: "rejected", reversed: "reversed" };
const entryLabel = (s?: string) => (s ? (ENTRY_STATUS[s] ?? s) : "");

export function InvoiceDetail({ id }: { id: string }) {
  return (
    <RequireAccess permission="billing.view" mode="404">
      <InvoiceDetailBody id={id} />
    </RequireAccess>
  );
}

function InvoiceDetailBody({ id }: { id: string }) {
  const q = useInvoice(id);
  const send = useSendInvoice();
  const cancel = useCancelInvoice();
  const emailInvoice = useEmailInvoice();
  const restore = useRestoreInvoice();
  const confirmClient = useConfirmCustomer();
  const stepUp = useStepUp();
  const askReason = useReason();
  const exportData = useExport();
  const viewer = useViewer();
  const [payOpen, setPayOpen] = React.useState(false);

  if (q.isPending)
    return (
      <div className="grid gap-4 pt-6">
        <Skeleton className="h-20 w-2/3" />
        <Skeleton className="h-[520px] w-full rounded-xl" />
      </div>
    );
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundBlock />;
    return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  }

  const { invoice: inv, customer, payments, reminders } = q.data;
  const open = ["sent", "part_paid", "overdue"].includes(inv.status);
  const pending = Number(inv.pendingPayments?.amount ?? 0);
  const total = Number(inv.total.amount);
  const paid = Number(inv.paid.amount);

  const onSend = async () => {
    try {
      await send.mutateAsync(inv.id);
      if (LIVE) toast.success("Invoice issued", { description: "Its ledger entry waits for approval. The client is emailed only once the entry is approved (when customer emails are set up)." });
      else toast.success(`${inv.number} sent to ${customer.name}`, { description: `Emailed to ${customer.email || "the customer"}. Reminders are scheduled.` });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't send the invoice.");
    }
  };
  const onCancel = async () => {
    const reason = await askReason({ title: `Cancel ${inv.number}`, description: "The invoice is kept with a Cancelled status; nothing is deleted. A reason is required.", confirmLabel: "Cancel invoice", destructive: true });
    if (!reason) return;
    // Cancelling an issued invoice reverses money: the server asks for the password again.
    if (LIVE && inv.status !== "draft" && !(await stepUp({ action: `Cancel ${inv.number}`, detail: "A reversing entry is made; it waits for approval." }))) return;
    try {
      await cancel.mutateAsync({ id: inv.id, reason });
      toast.success(`${inv.number} cancelled`, { description: LIVE && inv.ledgerEntryStatus === "posted" ? "A reversing entry waits for approval. Scheduled reminders were stopped." : "Scheduled reminders were stopped." });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't cancel the invoice.");
    }
  };

  const onEmail = async () => {
    try {
      await emailInvoice.mutateAsync(inv.id);
      toast.success("Emailing the invoice", { description: `To ${customer.email}.` });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't email the invoice.");
    }
  };
  const onRestore = async () => {
    try {
      await restore.mutateAsync(inv.id);
      toast.success(`${inv.number} restored`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't restore the invoice.");
    }
  };
  const onConfirmClient = async () => {
    try {
      await confirmClient.mutateAsync(customer.id);
      toast.success(`${customer.name} confirmed`, { description: "The invoice can now be issued." });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't confirm the client.");
    }
  };
  const invoiceEmailed = !!inv.emailedAt || (q.data.emails ?? []).some((e) => e.kind === "invoice" && e.status !== "skipped" && e.status !== "failed");

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{inv.number}</span>}
        description={`${customer.name} · issued ${formatDate(inv.issueDate)}`}
        seal="confidential"
        back={{ href: "/billing?tab=invoices", label: "Invoices" }}
        meta={
          <>
            <InvoiceStatusBadge status={inv.status} />
            <Badge tone="outline">
              <InvoiceTypeLabel invoice={inv} />
            </Badge>
            {open && <DeadlineChip deadline={inv.dueDate} />}
            {inv.source && (
              <Badge tone="sales">
                <Sparkles /> From deal {inv.source.dealNumber}
              </Badge>
            )}
          </>
        }
        actions={
          <>
            {LIVE ? (
              <Button variant="outline" onClick={() => window.open(`${API_BASE}/billing/invoices/${inv.id}/document`, "_blank", "noopener")}>
                <Printer /> Print
              </Button>
            ) : (
              <Button variant="outline" onClick={() => exportData({ title: `${inv.number} PDF`, seal: "confidential", formats: ["pdf"] })}>
                <Download /> PDF
              </Button>
            )}
            <Can permission="billing.manage" fallback={inv.status === "draft" || open ? <ViewOnlyNote className="py-1.5">View only. The finance person sends invoices and records payments.</ViewOnlyNote> : null}>
              {(inv.status === "draft" || (open && paid === 0 && pending === 0)) && (
                <Button variant="ghost" onClick={onCancel}>
                  <Ban /> Cancel
                </Button>
              )}
              {LIVE && inv.status === "cancelled" && inv.cancelEntryStatus === "rejected" && (
                <Button variant="outline" onClick={onRestore} loading={restore.isPending}>
                  <RotateCcw /> Restore
                </Button>
              )}
              {LIVE && open && !invoiceEmailed && inv.ledgerEntryStatus === "posted" && (
                <Button variant="outline" onClick={onEmail} loading={emailInvoice.isPending}>
                  <Mail /> Email to client
                </Button>
              )}
              {inv.status === "draft" && (
                <Button onClick={onSend} loading={send.isPending}>
                  <Send /> {LIVE ? "Issue invoice" : "Send invoice"}
                </Button>
              )}
              {open && (
                <Button onClick={() => setPayOpen(true)}>
                  <HandCoins /> Record payment
                </Button>
              )}
            </Can>
          </>
        }
      />

      {inv.source && inv.status === "draft" && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-zone-sales/35 bg-zone-sales/10 px-4 py-3 text-[13px]">
          <Sparkles className="size-4 shrink-0" />
          <span className="flex-1">
            Created automatically when deal <Mono>{inv.source.dealNumber}</Mono> was marked Won. Check the scope and amount, then send.
          </span>
          <EmpChip empId={inv.source.ownerEmpId} size="sm" subtitle="Deal owner" />
        </div>
      )}
      {LIVE && customer.needsReview && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-warning/45 bg-warning/10 px-4 py-3 text-[13px]">
          <span className="flex-1">
            The client <span className="font-medium">{customer.name}</span> was created automatically from Won deal {customer.createdFromDeal}. Check its details and
            confirm it before the invoice can be issued.
          </span>
          <Can permission="billing.manage">
            <Button size="sm" variant="outline" onClick={onConfirmClient} loading={confirmClient.isPending}>
              Confirm client
            </Button>
          </Can>
        </div>
      )}
      {LIVE && open && inv.ledgerEntryStatus === "pending_approval" && (
        <p className="mb-5 rounded-xl border border-border bg-muted px-4 py-3 text-[13px]">
          The ledger entry waits for approval. Nothing is sent to the client until it is approved.
        </p>
      )}
      {inv.status === "cancelled" && inv.cancelReason && (
        <p className="mb-5 rounded-xl border border-border bg-muted px-4 py-3 text-[13px]">
          <span className="font-medium">Cancelled:</span> {inv.cancelReason}
          {inv.cancelEntryNumber && (
            <span className="text-muted-foreground">
              {" "}
              · reversing entry <Mono>{inv.cancelEntryNumber}</Mono> {entryLabel(inv.cancelEntryStatus)}
              {inv.cancelEntryStatus === "rejected" ? ". The receivable is still in the ledger: restore the invoice or cancel it again." : ""}
            </span>
          )}
        </p>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)]">
        <InvoicePreview
          customer={customer}
          watermark={`Confidential, viewed by ${viewer?.employee.empId ?? ""} on ${formatDateTime(new Date())}`}
          invoice={{ ...inv, subtotal: Number(inv.subtotal.amount), tax: Number(inv.tax.amount), total, paid }}
        />

        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Balance</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="flex items-baseline justify-between">
                <Money value={inv.balance} exact className="text-2xl font-semibold" />
                <span className="text-[12.5px] text-muted-foreground">of {formatMoney(inv.total, { exact: true })}</span>
              </div>
              <Progress value={paid} max={total || 1} barClassName={inv.status === "paid" ? "bg-success" : inv.status === "overdue" ? "bg-danger" : "bg-zone-finance"} label="Paid so far" />
              <p className="text-[12.5px] text-muted-foreground">
                {inv.status === "paid"
                  ? "Paid in full."
                  : inv.status === "draft"
                    ? "Not sent yet."
                    : inv.status === "cancelled"
                      ? "Cancelled. No payment expected."
                      : `${formatMoney(inv.paid, { exact: true })} received. Due ${formatDate(inv.dueDate)}.`}
              </p>
              {pending > 0 && inv.pendingPayments && (
                <p className="text-[12.5px] text-muted-foreground">
                  {formatMoney(inv.pendingPayments, { exact: true })} recorded and waiting for approval. It counts as paid once its ledger entry is approved.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Payments</CardTitle>
                <CardDescription>{LIVE ? "Each payment is a ledger entry; it counts once approved." : "Each payment is posted to the ledger."}</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {payments.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">No payments yet.</p>
              ) : (
                <ul className="grid gap-2">
                  {payments.map((p) => (
                    <li key={p.id} className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium">{PAYMENT_METHOD[p.method]}</p>
                        <p className="text-[12px] text-muted-foreground">
                          {formatDate(p.date)}
                          {p.reference ? (
                            <>
                              {" · "}
                              <Mono>{p.reference}</Mono>
                            </>
                          ) : null}
                        </p>
                        {p.ledgerEntryNumber && (
                          <Link href="/finance/ledger" className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-primary hover:underline">
                            <BookOpen className="size-3" /> <Mono>{p.ledgerEntryNumber}</Mono>
                            {p.ledgerEntryStatus && <span className="text-muted-foreground">· {entryLabel(p.ledgerEntryStatus)}</span>}
                          </Link>
                        )}
                      </div>
                      <Money value={p.amount} exact className="text-[13px]" />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Reminders</CardTitle>
                <CardDescription>
                  {inv.status === "draft"
                    ? "Scheduled when the invoice is issued."
                    : LIVE
                      ? "To the client by email and to the assigned staff member in the app. None after the invoice is paid or cancelled."
                      : "Emails to the customer around the due date."}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {reminders.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  {inv.status === "draft" ? `${inv.reminders.length} reminder${inv.reminders.length === 1 ? "" : "s"}: ${inv.reminders.map((r) => reminderLabel(r.offsetDays).toLowerCase()).join(", ")}.` : "No reminders for this invoice."}
                </p>
              ) : (
                <Timeline items={reminders.map(reminderItem)} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Ledger</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-[13px]">
              {inv.ledgerEntryNumber ? (
                <p className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Invoice entry</span>
                  <Link href="/finance/ledger" className="inline-flex items-center gap-1 text-primary hover:underline">
                    <BookOpen className="size-3.5" /> <Mono>{inv.ledgerEntryNumber}</Mono>
                  </Link>
                </p>
              ) : (
                <p className="text-muted-foreground">
                  {LIVE
                    ? "A draft is not in the ledger. Issuing it creates its entry (Dr Accounts receivable, Cr Income), which waits for approval."
                    : "Posted to the ledger when the invoice is sent (Dr Accounts receivable, Cr Revenue)."}
                </p>
              )}
              {inv.ledgerEntryStatus && (
                <p className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Entry status</span>
                  <span>{entryLabel(inv.ledgerEntryStatus)}</span>
                </p>
              )}
              {inv.assignedTo && (
                <p className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Reminded staff member</span>
                  <EmpChip empId={inv.assignedTo} size="sm" showId={false} />
                </p>
              )}
              <p className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Created by</span>
                {inv.createdBy ? <EmpChip empId={inv.createdBy} size="sm" showId={false} /> : <span>The system</span>}
              </p>
            </CardContent>
          </Card>
          {LIVE && <LiveExtras data={q.data} />}
        </div>
      </div>

      {payOpen && <RecordPaymentDialog invoice={inv} onClose={() => setPayOpen(false)} />}
    </>
  );
}

function reminderItem(r: ReminderEvent): TimelineItem {
  const base = { id: r.id, time: formatDate(r.scheduledFor) };
  const to = r.audience === "customer" ? " · to the client" : r.audience === "staff" ? " · to the staff member" : "";
  if (r.status === "sent") return { ...base, icon: <Mail />, color: "var(--info)", title: `Sent · ${reminderLabel(r.offsetDays).toLowerCase()}${to}`, meta: r.sentAt ? formatDateTime(r.sentAt) : undefined };
  if (r.status === "skipped") return { ...base, icon: <BellOff />, title: `Skipped · ${reminderLabel(r.offsetDays).toLowerCase()}${to}`, meta: r.reason ?? "Not needed", muted: true };
  return { ...base, icon: <Clock />, title: `Scheduled · ${reminderLabel(r.offsetDays).toLowerCase()}${to}`, meta: LIVE ? "Goes out with the daily billing run (09:00)" : "Will go out at 10:00" };
}

const EMAIL_STATUS: Record<string, string> = { pending: "Waiting to send", sending: "Sending", sent: "Sent", failed: "Failed", skipped: "Not sent", unknown: "Interrupted (not resent)" };

/** Live only: emails to the client and the recurring rule behind this invoice. */
function LiveExtras({ data }: { data: InvoiceDetailData }) {
  const stop = useStopRecurring();
  const askReason = useReason();
  const rule = data.recurringRule;
  const onStop = async () => {
    if (!rule) return;
    const reason = await askReason({ title: "Stop this recurring invoice", description: "No new drafts are created after this. Invoices already made stay as they are.", confirmLabel: "Stop", destructive: true });
    if (!reason) return;
    try {
      await stop.mutateAsync({ id: rule.id, reason });
      toast.success("Recurring invoice stopped");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't stop it.");
    }
  };
  return (
    <>
      {rule && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{rule.kind === "rental" ? "Rental" : "Recurring"} invoice</CardTitle>
              <CardDescription>A draft is created at the start of each period for the finance person to check and issue.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-2 text-[13px]">
            <p className="flex justify-between gap-2"><span className="text-muted-foreground">Amount each period</span><Money value={rule.total} exact /></p>
            <p className="flex justify-between gap-2"><span className="text-muted-foreground">From</span><span>{formatDate(rule.startDate)}{rule.endDate ? ` to ${formatDate(rule.endDate)}` : ", until stopped"}</span></p>
            <p className="flex justify-between gap-2"><span className="text-muted-foreground">Next draft</span><span>{rule.nextPeriodStart ? formatDate(rule.nextPeriodStart) : rule.endReason ?? "Stopped"}</span></p>
            <p className="flex justify-between gap-2"><span className="text-muted-foreground">Invoices so far</span><span className="tabular">{rule.invoiceCount}</span></p>
            {rule.status === "active" && (
              <Can permission="billing.manage">
                <Button size="sm" variant="outline" className="w-fit" onClick={onStop} loading={stop.isPending}>
                  <Repeat /> Stop recurring
                </Button>
              </Can>
            )}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Emails to the client</CardTitle>
            <CardDescription>Sent from the address in the billing settings, only after the invoice&apos;s ledger entry is approved. Nothing is sent while customer emails are off.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {(data.emails ?? []).length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No emails to the client yet.</p>
          ) : (
            <ul className="grid gap-2 text-[13px]">
              {data.emails!.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2">
                  <span>{e.kind === "invoice" ? "The invoice" : "Reminder"}</span>
                  <span className="text-right text-muted-foreground">
                    {EMAIL_STATUS[e.status] ?? e.status}
                    {e.sentAt ? ` · ${formatDateTime(e.sentAt)}` : ""}
                    {e.note ? <span className="block text-[12px]">{e.note}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

const paySchema = z.object({
  date: z.string().min(1, "Choose the date"),
  amount: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "Enter an amount, e.g. 1500 or 1500.50"),
  method: z.enum(["bank_transfer", "cash", "cheque", "card_provider", "other"]),
  reference: z.string(),
});
type PayValues = z.infer<typeof paySchema>;

function RecordPaymentDialog({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const record = useRecordPayment();
  const banks = useBankAccounts(LIVE);
  const accounts = (banks.data ?? []).filter((b) => b.currency === invoice.currency);
  const [bankAccountId, setBankAccountId] = React.useState("");
  // One key per dialog: sending it again (a retry, a double click) records nothing more.
  const requestKey = React.useMemo(() => crypto.randomUUID(), []);
  // Payments waiting for approval are already allocated: what is left to record is the balance minus those.
  const balance = Number(invoice.balance.amount) - Number(invoice.pendingPayments?.amount ?? 0);
  const { register, handleSubmit, setValue, watch, formState } = useForm<PayValues>({
    resolver: zodResolver(paySchema),
    defaultValues: { date: isoDay(new Date()), amount: balance.toFixed(2), method: "bank_transfer", reference: "" },
  });
  const amount = Number(watch("amount")) || 0;
  const errors = formState.errors;
  const after = Math.max(0, balance - amount);

  const onSubmit = handleSubmit(async (v) => {
    if (Number(v.amount) > balance + 0.005) return toast.error(`That's more than the balance (${formatMoney(balance, { currency: invoice.currency, exact: true })}).`);
    const bank = bankAccountId || accounts[0]?.id;
    if (LIVE && !bank) return toast.error(`No ${invoice.currency} bank account is set up in the ledger.`);
    try {
      await record.mutateAsync({ id: invoice.id, input: { date: new Date(`${v.date}T12:00`).toISOString(), amount: v.amount, method: v.method as PaymentMethod, reference: v.reference.trim() || undefined, bankAccountId: bank, requestKey } });
      if (LIVE) toast.success("Payment recorded", { description: "Its ledger entry waits for approval. The invoice counts it as paid once it is approved." });
      else toast.success("Payment recorded", { description: after <= 0.005 ? `${invoice.number} is now paid. Remaining reminders were cancelled.` : `Balance now ${formatMoney(after, { currency: invoice.currency, exact: true })}.` });
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't record the payment.");
    }
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>
            {invoice.number} · balance {formatMoney(invoice.balance, { exact: true })}. Card details are never stored here.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date received" htmlFor="pay-date" error={errors.date?.message}>
              <Input id="pay-date" type="date" {...register("date")} />
            </Field>
            <Field label={`Amount (${invoice.currency})`} htmlFor="pay-amount" error={errors.amount?.message}>
              <Input id="pay-amount" inputMode="decimal" className="text-right font-mono" autoFocus {...register("amount")} aria-invalid={!!errors.amount || undefined} />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setValue("amount", balance.toFixed(2))}>
              Full balance
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setValue("amount", (balance / 2).toFixed(2))}>
              Half
            </Button>
          </div>
          {LIVE && (
            <Field label="Received in" htmlFor="pay-bank" hint={accounts.length ? undefined : `No ${invoice.currency} bank account in the ledger yet.`}>
              <NativeSelect id="pay-bank" value={bankAccountId || accounts[0]?.id || ""} onChange={(e) => setBankAccountId(e.target.value)}>
                {accounts.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="Method" htmlFor="pay-method">
            <NativeSelect id="pay-method" {...register("method")}>
              {Object.entries(PAYMENT_METHOD).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Reference (optional)" htmlFor="pay-ref" hint="Bank transfer ID, cheque number or receipt number. Never a card number.">
            <Input id="pay-ref" {...register("reference")} />
          </Field>
          <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-[13px]">
            <span className="text-muted-foreground">Balance after this payment</span>
            <span className="flex items-center gap-1.5 font-mono font-semibold tabular">
              {after <= 0.005 && <Check className="size-4 text-success" />}
              {formatMoney(after, { currency: invoice.currency, exact: true })}
            </span>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={record.isPending}>
              Record payment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
