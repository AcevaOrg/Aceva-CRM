"use client";
import * as React from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Ban, BellOff, BookOpen, Check, Clock, Download, HandCoins, Mail, Send, Sparkles } from "lucide-react";
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
import { useExport, useReason } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { Mono, Money } from "@/components/shared/money";
import { ErrorState } from "@/components/shared/states";
import { Timeline, type TimelineItem } from "@/components/shared/timeline";
import { ApiError } from "@/lib/api/mock";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime, isoDay } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { useCancelInvoice, useInvoice, useRecordPayment, useSendInvoice } from "../hooks";
import { PAYMENT_METHOD, reminderLabel } from "../logic";
import type { Invoice, PaymentMethod, ReminderEvent } from "../types";
import { InvoiceStatusBadge, InvoiceTypeLabel, ViewOnlyNote } from "./bits";
import { InvoicePreview } from "./invoice-preview";

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
  const total = Number(inv.total.amount);
  const paid = Number(inv.paid.amount);

  const onSend = async () => {
    try {
      await send.mutateAsync(inv.id);
      toast.success(`${inv.number} sent to ${customer.name}`, { description: `Emailed to ${customer.email || "the customer"}. Reminders are scheduled.` });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't send the invoice.");
    }
  };
  const onCancel = async () => {
    const reason = await askReason({ title: `Cancel ${inv.number}`, description: "The invoice is kept with a Cancelled status; nothing is deleted. A reason is required.", confirmLabel: "Cancel invoice", destructive: true });
    if (!reason) return;
    try {
      await cancel.mutateAsync({ id: inv.id, reason });
      toast.success(`${inv.number} cancelled`, { description: "Scheduled reminders were stopped." });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't cancel the invoice.");
    }
  };

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
            <Button variant="outline" onClick={() => exportData({ title: `${inv.number} PDF`, seal: "confidential", formats: ["pdf"] })}>
              <Download /> PDF
            </Button>
            <Can permission="billing.manage" fallback={inv.status === "draft" || open ? <ViewOnlyNote className="py-1.5">View only. The finance person sends invoices and records payments.</ViewOnlyNote> : null}>
              {(inv.status === "draft" || (open && paid === 0)) && (
                <Button variant="ghost" onClick={onCancel}>
                  <Ban /> Cancel
                </Button>
              )}
              {inv.status === "draft" && (
                <Button onClick={onSend} loading={send.isPending}>
                  <Send /> Send invoice
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
      {inv.status === "cancelled" && inv.cancelReason && (
        <p className="mb-5 rounded-xl border border-border bg-muted px-4 py-3 text-[13px]">
          <span className="font-medium">Cancelled:</span> {inv.cancelReason}
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Payments</CardTitle>
                <CardDescription>Each payment is posted to the ledger.</CardDescription>
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
                <CardDescription>{inv.status === "draft" ? "Scheduled when the invoice is sent." : "Emails to the customer around the due date."}</CardDescription>
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
                <p className="text-muted-foreground">Posted to the ledger when the invoice is sent (Dr Accounts receivable, Cr Revenue).</p>
              )}
              <p className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Created by</span>
                <EmpChip empId={inv.createdBy} size="sm" showId={false} />
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {payOpen && <RecordPaymentDialog invoice={inv} onClose={() => setPayOpen(false)} />}
    </>
  );
}

function reminderItem(r: ReminderEvent): TimelineItem {
  const base = { id: r.id, time: formatDate(r.scheduledFor) };
  if (r.status === "sent") return { ...base, icon: <Mail />, color: "var(--info)", title: `Sent · ${reminderLabel(r.offsetDays).toLowerCase()}`, meta: r.sentAt ? formatDateTime(r.sentAt) : undefined };
  if (r.status === "skipped") return { ...base, icon: <BellOff />, title: `Skipped · ${reminderLabel(r.offsetDays).toLowerCase()}`, meta: r.reason ?? "Not needed", muted: true };
  return { ...base, icon: <Clock />, title: `Scheduled · ${reminderLabel(r.offsetDays).toLowerCase()}`, meta: "Will go out at 10:00" };
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
  const balance = Number(invoice.balance.amount);
  const { register, handleSubmit, setValue, watch, formState } = useForm<PayValues>({
    resolver: zodResolver(paySchema),
    defaultValues: { date: isoDay(new Date()), amount: balance.toFixed(2), method: "bank_transfer", reference: "" },
  });
  const amount = Number(watch("amount")) || 0;
  const errors = formState.errors;
  const after = Math.max(0, balance - amount);

  const onSubmit = handleSubmit(async (v) => {
    if (Number(v.amount) > balance + 0.005) return toast.error(`That's more than the balance (${formatMoney(invoice.balance, { exact: true })}).`);
    try {
      await record.mutateAsync({ id: invoice.id, input: { date: new Date(`${v.date}T12:00`).toISOString(), amount: v.amount, method: v.method as PaymentMethod, reference: v.reference.trim() || undefined } });
      toast.success("Payment recorded", { description: after <= 0.005 ? `${invoice.number} is now paid. Remaining reminders were cancelled.` : `Balance now ${formatMoney(after, { currency: invoice.currency, exact: true })}.` });
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
          <Field label="Method" htmlFor="pay-method">
            <NativeSelect id="pay-method" {...register("method")}>
              {Object.entries(PAYMENT_METHOD).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Reference (optional)" htmlFor="pay-ref" hint="Bank transfer ID, cheque number or receipt number.">
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
