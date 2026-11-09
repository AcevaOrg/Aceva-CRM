"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Bell, Plus, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { ApiError } from "@/lib/api/mock";
import { formatDate, isoDay } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useCreateInvoice, useCustomerList } from "../hooks";
import { DEFAULT_REMINDERS, dueDateFrom, invoiceTotals, lineAmount, reminderLabel, reminderSchedule } from "../logic";
import type { NewInvoiceInput } from "../types";
import { InvoicePreview } from "./invoice-preview";

const amount = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "Enter an amount, e.g. 1500 or 1500.50");

const schema = z
  .object({
    customerId: z.string().min(1, "Choose a customer"),
    type: z.enum(["one_time", "recurring", "rental"]),
    period: z.enum(["monthly", "quarterly", "yearly"]),
    periodStart: z.string(),
    periodEnd: z.string(),
    issueDate: z.string().min(1, "Choose the issue date"),
    termsDays: z.string().regex(/^\d{1,3}$/, "Days, e.g. 14"),
    currency: z.enum(["PKR", "USD"]),
    lines: z
      .array(
        z.object({
          description: z.string().trim().min(2, "Describe the line"),
          qty: z.string().trim().regex(/^\d+(\.\d+)?$/, "Number"),
          rate: amount,
          taxRate: z.string(),
        }),
      )
      .min(1, "Add at least one line"),
    reminders: z.array(z.number()),
    notes: z.string(),
  })
  .refine((v) => v.type === "one_time" || !v.periodEnd || v.periodEnd >= v.periodStart, { path: ["periodEnd"], message: "The end must be after the start" });

type FormValues = z.infer<typeof schema>;

const REMINDER_OPTIONS = [-7, -3, -1, 0, 3, 7, 14];

export function InvoiceEditor() {
  return (
    <RequireAccess permission="billing.view" mode="404">
      <RequireAccess permission="billing.manage">
        <InvoiceEditorForm />
      </RequireAccess>
    </RequireAccess>
  );
}

function InvoiceEditorForm() {
  const router = useRouter();
  const customers = useCustomerList();
  const create = useCreateInvoice();
  const [sending, setSending] = React.useState<"draft" | "send" | null>(null);
  const today = isoDay(new Date());

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      customerId: "",
      type: "one_time",
      period: "monthly",
      periodStart: today,
      periodEnd: "",
      issueDate: today,
      termsDays: "14",
      currency: "PKR",
      lines: [{ description: "", qty: "1", rate: "", taxRate: "15" }],
      reminders: DEFAULT_REMINDERS.map((r) => r.offsetDays),
      notes: "",
    },
  });
  const { register, control, handleSubmit, setValue, formState } = form;
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const v = useWatch({ control }) as FormValues;
  const errors = formState.errors;

  const customer = customers.data?.find((c) => c.id === v.customerId);
  const terms = Number(v.termsDays) || 0;
  const due = v.issueDate ? dueDateFrom(v.issueDate, terms) : undefined;
  const lines = (v.lines ?? []).map((l) => ({ description: l.description, qty: Number(l.qty) || 0, rate: l.rate || "0", taxRate: Number(l.taxRate) || 0 }));
  const totals = invoiceTotals(lines);
  const schedule = due ? reminderSchedule(due, (v.reminders ?? []).map((offsetDays) => ({ offsetDays }))) : [];

  const onCustomer = (id: string) => {
    setValue("customerId", id, { shouldValidate: true });
    const c = customers.data?.find((x) => x.id === id);
    if (!c) return;
    setValue("currency", c.currency);
    setValue("termsDays", String(c.termsDays));
    // Sindh sales tax on services for local customers; exports are zero-rated.
    (form.getValues("lines") ?? []).forEach((_, i) => setValue(`lines.${i}.taxRate`, c.currency === "PKR" ? "15" : "0"));
  };

  const submit = (send: boolean) =>
    handleSubmit(async (values) => {
      setSending(send ? "send" : "draft");
      const input: NewInvoiceInput = {
        customerId: values.customerId,
        type: values.type,
        period: values.type === "one_time" ? undefined : values.period,
        periodStart: values.type === "one_time" ? undefined : new Date(`${values.periodStart}T09:00`).toISOString(),
        periodEnd: values.type === "one_time" || !values.periodEnd ? undefined : new Date(`${values.periodEnd}T09:00`).toISOString(),
        issueDate: new Date(`${values.issueDate}T11:00`).toISOString(),
        termsDays: Number(values.termsDays),
        currency: values.currency,
        lines: values.lines.map((l) => ({ description: l.description.trim(), qty: Number(l.qty), rate: Number(l.rate).toFixed(2), taxRate: Number(l.taxRate) || undefined })),
        reminders: values.reminders.map((offsetDays) => ({ offsetDays })),
        notes: values.notes.trim() || undefined,
      };
      try {
        const inv = await create.mutateAsync({ input, send });
        toast.success(send ? `${inv.number} sent to ${customer?.name}` : `${inv.number} saved as a draft`, {
          description: send ? "Reminders are scheduled. The invoice is posted to the ledger." : "Nothing was sent yet.",
        });
        router.push(`/billing/invoices/${inv.id}`);
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "Couldn't save the invoice.");
      } finally {
        setSending(null);
      }
    })();

  return (
    <>
      <PageHeader
        title="New invoice"
        description="Fill in the details on the left. The right side shows exactly what the customer will receive."
        seal="confidential"
        back={{ href: "/billing?tab=invoices", label: "Invoices" }}
        actions={
          <>
            <Button variant="outline" onClick={() => submit(false)} loading={sending === "draft"} disabled={!!sending}>
              Save draft
            </Button>
            <Button onClick={() => submit(true)} loading={sending === "send"} disabled={!!sending}>
              <Send /> Send invoice
            </Button>
          </>
        }
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <form className="grid gap-5" onSubmit={(e) => e.preventDefault()} noValidate>
          <Card>
            <CardHeader>
              <CardTitle>Customer and type</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field label="Customer" htmlFor="customerId" required error={errors.customerId?.message}>
                <NativeSelect id="customerId" value={v.customerId} onChange={(e) => onCustomer(e.target.value)} aria-invalid={!!errors.customerId || undefined}>
                  <option value="">Choose a customer</option>
                  {customers.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.currency}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Type">
                <SegmentedControl
                  value={v.type}
                  onChange={(t) => setValue("type", t)}
                  ariaLabel="Invoice type"
                  options={[
                    { value: "one_time", label: "One-time" },
                    { value: "recurring", label: "Recurring" },
                    { value: "rental", label: "Rental" },
                  ]}
                />
              </Field>
              {v.type !== "one_time" && (
                <div className="grid gap-4 rounded-lg border border-dashed border-border p-3 sm:grid-cols-3">
                  <Field label="Billing period" htmlFor="period">
                    <NativeSelect id="period" {...register("period")}>
                      <option value="monthly">Monthly</option>
                      <option value="quarterly">Quarterly</option>
                      <option value="yearly">Yearly</option>
                    </NativeSelect>
                  </Field>
                  <Field label="Starts" htmlFor="periodStart">
                    <Input id="periodStart" type="date" {...register("periodStart")} />
                  </Field>
                  <Field label="Ends" htmlFor="periodEnd" hint="Empty = until cancelled" error={errors.periodEnd?.message}>
                    <Input id="periodEnd" type="date" {...register("periodEnd")} />
                  </Field>
                  <p className="text-[12px] text-muted-foreground sm:col-span-3">
                    A new invoice is created at the start of each period from this one. The customer gets the same reminder schedule each time.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Dates and currency</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <Field label="Issue date" htmlFor="issueDate" error={errors.issueDate?.message}>
                <Input id="issueDate" type="date" {...register("issueDate")} />
              </Field>
              <Field label="Payment terms" htmlFor="termsDays" error={errors.termsDays?.message} hint={due ? `Due ${formatDate(due)}` : undefined}>
                <div className="relative">
                  <Input id="termsDays" inputMode="numeric" className="pr-12" {...register("termsDays")} />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">days</span>
                </div>
              </Field>
              <Field label="Currency">
                <SegmentedControl value={v.currency} onChange={(c) => setValue("currency", c)} ariaLabel="Currency" options={[{ value: "PKR", label: "PKR" }, { value: "USD", label: "USD" }]} />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Lines</CardTitle>
                <CardDescription>Tax: 15% Sindh sales tax on services for local customers; exports are zero-rated.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              {fields.map((f, i) => {
                const le = errors.lines?.[i];
                return (
                  <div key={f.id} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_70px_120px_70px_auto] sm:items-start sm:border-0 sm:p-0">
                    <Field label={i === 0 ? "Description" : undefined} error={le?.description?.message}>
                      <Input placeholder="What are you billing for?" aria-label={`Line ${i + 1} description`} {...register(`lines.${i}.description`)} aria-invalid={!!le?.description || undefined} />
                    </Field>
                    <Field label={i === 0 ? "Qty" : undefined} error={le?.qty?.message}>
                      <Input inputMode="decimal" className="text-right font-mono" aria-label={`Line ${i + 1} quantity`} {...register(`lines.${i}.qty`)} />
                    </Field>
                    <Field label={i === 0 ? "Rate" : undefined} error={le?.rate?.message}>
                      <Input inputMode="decimal" placeholder="0.00" className="text-right font-mono" aria-label={`Line ${i + 1} rate`} {...register(`lines.${i}.rate`)} aria-invalid={!!le?.rate || undefined} />
                    </Field>
                    <Field label={i === 0 ? "Tax %" : undefined}>
                      <NativeSelect aria-label={`Line ${i + 1} tax`} {...register(`lines.${i}.taxRate`)}>
                        <option value="0">0%</option>
                        <option value="13">13%</option>
                        <option value="15">15%</option>
                        <option value="16">16%</option>
                      </NativeSelect>
                    </Field>
                    <div className={cn("flex items-center justify-between gap-2 sm:justify-end", i === 0 && "sm:mt-[22px]")}>
                      <span className="font-mono text-[12.5px] tabular text-muted-foreground sm:hidden">{lineAmount(lines[i] ?? { qty: 0, rate: "0" }).toFixed(2)}</span>
                      <Button type="button" size="icon-sm" variant="ghost" onClick={() => remove(i)} disabled={fields.length === 1} aria-label={`Remove line ${i + 1}`}>
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                );
              })}
              {errors.lines?.root?.message && <p className="text-xs text-danger">{errors.lines.root.message}</p>}
              <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => append({ description: "", qty: "1", rate: "", taxRate: v.currency === "PKR" ? "15" : "0" })}>
                <Plus /> Add line
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Reminders</CardTitle>
                <CardDescription>Sent by email from accounts@acevatech.com. Paid invoices never get another reminder.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-[auto_1fr]">
              <div className="grid content-start gap-2">
                {REMINDER_OPTIONS.map((o) => {
                  const on = v.reminders?.includes(o);
                  return (
                    <label key={o} className="flex cursor-pointer items-center gap-2.5 text-[13px]">
                      <Checkbox
                        checked={!!on}
                        onCheckedChange={(c) =>
                          setValue(
                            "reminders",
                            c ? [...(v.reminders ?? []), o].sort((a, b) => a - b) : (v.reminders ?? []).filter((x) => x !== o),
                          )
                        }
                      />
                      {reminderLabel(o)}
                    </label>
                  );
                })}
              </div>
              <ReminderTimeline due={due} schedule={schedule} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <Field label="Note on the invoice (optional)" htmlFor="notes" hint="Shown to the customer under the payment details.">
                <Textarea id="notes" rows={2} placeholder="Thank you for your business." {...register("notes")} />
              </Field>
            </CardContent>
          </Card>
        </form>

        <div className="grid gap-3 xl:sticky xl:top-20">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Live preview</p>
          <InvoicePreview
            customer={customer}
            invoice={{
              number: "INV-2026-____",
              type: v.type,
              period: v.type === "one_time" ? undefined : v.period,
              issueDate: v.issueDate ? new Date(`${v.issueDate}T11:00`).toISOString() : "",
              dueDate: due ? due.toISOString() : "",
              currency: v.currency,
              status: "draft",
              notes: v.notes,
              lines,
              subtotal: totals.subtotal,
              tax: totals.tax,
              total: totals.total,
            }}
          />
        </div>
      </div>
    </>
  );
}

function ReminderTimeline({ due, schedule }: { due?: Date; schedule: { offsetDays: number; date: Date; label: string }[] }) {
  if (!due) return null;
  if (!schedule.length)
    return <p className="rounded-lg bg-muted p-3 text-[12.5px] text-muted-foreground">No reminders. The customer only receives the invoice itself.</p>;
  const first = schedule[0].offsetDays;
  const last = schedule[schedule.length - 1].offsetDays;
  const span = Math.max(1, last - first);
  const pos = (o: number) => ((o - first) / span) * 100;
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4" aria-label="Reminder schedule">
      <div className="relative mx-10 mb-14 mt-8 h-1 rounded-full bg-border">
        {schedule.map((r) => (
          <div key={r.offsetDays} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${pos(r.offsetDays)}%` }}>
            <span className={cn("block size-3 rounded-full ring-4 ring-card", r.offsetDays === 0 ? "bg-primary" : r.offsetDays < 0 ? "bg-info" : "bg-warning")} />
            <span className="absolute left-1/2 top-4 w-20 -translate-x-1/2 text-center text-[11px] leading-tight text-muted-foreground">
              <span className="block font-medium text-foreground tabular">{formatDate(r.date).replace(/ \d{4}$/, "")}</span>
              {r.label}
            </span>
          </div>
        ))}
        {first > 0 || last < 0 ? null : (
          <span className="absolute -top-6 -translate-x-1/2 text-[10.5px] font-semibold uppercase tracking-wider text-primary" style={{ left: `${pos(0)}%` }}>
            Due
          </span>
        )}
      </div>
      <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Bell className="size-3.5" /> {schedule.length} reminder{schedule.length === 1 ? "" : "s"}, the last on {formatDate(schedule[schedule.length - 1].date)}.
      </p>
    </div>
  );
}
