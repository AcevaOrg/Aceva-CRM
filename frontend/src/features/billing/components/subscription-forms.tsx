"use client";
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmployeeSelect } from "@/components/shared/pickers";
import { ApiError } from "@/lib/api/mock";
import { formatDate, isoDay } from "@/lib/dates";
import { formatMoney, formatNumber } from "@/lib/format";
import { useAddUsageReading, useDecideRenewal, useSaveSubscription } from "../hooks";
import { money, SUB_CATEGORY } from "../logic";
import type { RenewalDecision, Subscription } from "../types";

const schema = z.object({
  vendor: z.string().trim().min(2, "Who do we pay?"),
  product: z.string().trim().min(2, "What is it for?"),
  category: z.enum(["sales_tools", "domains_email", "ai", "hosting", "api", "dev_tools", "crm"]),
  ownerEmpId: z.string().min(1, "Choose the responsible person"),
  plan: z.string().trim().min(1, "Plan name"),
  amount: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "Amount, e.g. 99 or 215.28"),
  currency: z.enum(["PKR", "USD"]),
  period: z.enum(["monthly", "quarterly", "yearly", "usage"]),
  renewalDate: z.string().min(1, "Choose the renewal date"),
  alertDaysBefore: z.string().regex(/^\d{1,3}$/, "Days"),
  seats: z.string().regex(/^\d*$/, "Whole number"),
  notes: z.string(),
});
type Values = z.infer<typeof schema>;

/** Add or edit an entry in the subscription register. */
export function SubscriptionSheet({ sub, open, onOpenChange }: { sub?: Subscription; open: boolean; onOpenChange: (o: boolean) => void }) {
  const save = useSaveSubscription();
  const { register, handleSubmit, setValue, watch, reset, formState } = useForm<Values>({ resolver: zodResolver(schema) });
  const errors = formState.errors;

  React.useEffect(() => {
    if (!open) return;
    reset({
      vendor: sub?.vendor ?? "",
      product: sub?.product ?? "",
      category: sub?.category ?? "sales_tools",
      ownerEmpId: sub?.ownerEmpId ?? "",
      plan: sub?.plan ?? "",
      amount: sub ? Number(sub.cost.amount).toFixed(2) : "",
      currency: sub?.cost.currency ?? "USD",
      period: sub?.period ?? "monthly",
      renewalDate: sub ? isoDay(sub.renewalDate) : isoDay(new Date(Date.now() + 30 * 86400_000)),
      alertDaysBefore: String(sub?.alertDaysBefore ?? 7),
      seats: sub?.seats ? String(sub.seats) : "",
      notes: sub?.notes ?? "",
    });
  }, [open, sub, reset]);

  const onSubmit = handleSubmit(async (v) => {
    try {
      await save.mutateAsync({
        id: sub?.id ?? "",
        vendor: v.vendor,
        product: v.product,
        category: v.category,
        ownerEmpId: v.ownerEmpId,
        plan: v.plan,
        cost: money(Number(v.amount), v.currency),
        period: v.period,
        renewalDate: new Date(`${v.renewalDate}T00:00`).toISOString(),
        alertDaysBefore: Number(v.alertDaysBefore),
        seats: v.seats ? Number(v.seats) : undefined,
        notes: v.notes.trim() || undefined,
        usage: sub?.usage,
        status: sub?.status === "cancelled" ? "cancelled" : undefined,
      });
      toast.success(sub ? `${v.vendor} updated` : `${v.vendor} added to the register`, { description: "The change is saved in the audit log." });
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save.");
    }
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="md">
        <SheetHeader>
          <SheetTitle>{sub ? `Edit ${sub.vendor}` : "Add a subscription"}</SheetTitle>
          <SheetDescription>Tools, domains, mailboxes and services Aceva pays for.</SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
          <SheetBody className="grid content-start gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Vendor" htmlFor="s-vendor" error={errors.vendor?.message}>
                <Input id="s-vendor" placeholder="Apollo.io" {...register("vendor")} />
              </Field>
              <Field label="Category" htmlFor="s-cat">
                <NativeSelect id="s-cat" {...register("category")}>
                  {Object.entries(SUB_CATEGORY).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <Field label="What it's for" htmlFor="s-product" error={errors.product?.message}>
              <Input id="s-product" placeholder="Sales prospecting and sequences" {...register("product")} />
            </Field>
            <Field label="Responsible person" htmlFor="s-owner" error={errors.ownerEmpId?.message} hint="Gets the renewal reminders.">
              <EmployeeSelect id="s-owner" value={watch("ownerEmpId") ?? ""} onChange={(id) => setValue("ownerEmpId", id, { shouldValidate: true })} filter={(e) => e.level <= 4 || e.duties.includes("finance")} invalid={!!errors.ownerEmpId} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Plan" htmlFor="s-plan" error={errors.plan?.message}>
                <Input id="s-plan" placeholder="Professional · 3 seats" {...register("plan")} />
              </Field>
              <Field label="Seats (optional)" htmlFor="s-seats" error={errors.seats?.message}>
                <Input id="s-seats" inputMode="numeric" {...register("seats")} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <Field label="Cost" htmlFor="s-amount" error={errors.amount?.message}>
                <Input id="s-amount" inputMode="decimal" className="font-mono" {...register("amount")} />
              </Field>
              <Field label="Currency">
                <SegmentedControl value={watch("currency") ?? "USD"} onChange={(c) => setValue("currency", c)} options={[{ value: "USD", label: "USD" }, { value: "PKR", label: "PKR" }]} ariaLabel="Currency" />
              </Field>
            </div>
            <Field label="Billing period" htmlFor="s-period">
              <NativeSelect id="s-period" {...register("period")}>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="yearly">Yearly</option>
                <option value="usage">Usage-based</option>
              </NativeSelect>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Next renewal" htmlFor="s-renew" error={errors.renewalDate?.message}>
                <Input id="s-renew" type="date" {...register("renewalDate")} />
              </Field>
              <Field label="Remind this many days before" htmlFor="s-alert" error={errors.alertDaysBefore?.message}>
                <Input id="s-alert" inputMode="numeric" {...register("alertDaysBefore")} />
              </Field>
            </div>
            <Field label="Notes (optional)" htmlFor="s-notes">
              <Textarea id="s-notes" rows={3} {...register("notes")} />
            </Field>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {sub ? "Save changes" : "Add subscription"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** Record what was decided before a renewal: renewed, changed or cancelled (plan §18). */
export function RenewalDecisionDialog({ sub, onClose }: { sub: Subscription; onClose: () => void }) {
  const decide = useDecideRenewal();
  const [decision, setDecision] = React.useState<RenewalDecision["decision"]>("renewed");
  const [note, setNote] = React.useState("");
  const [newCost, setNewCost] = React.useState(Number(sub.cost.amount).toFixed(2));
  const costOk = decision !== "changed" || /^\d+(\.\d{1,2})?$/.test(newCost);
  const run = async () => {
    try {
      await decide.mutateAsync({ id: sub.id, decision, note: note.trim() || undefined, newCost: decision === "changed" ? newCost : undefined });
      toast.success(`${sub.vendor}: ${decision}`, { description: "Saved in the renewal log." });
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the decision.");
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Renewal decision · {sub.vendor}</DialogTitle>
          <DialogDescription>
            {sub.plan} · {formatMoney(sub.cost)} · renews {formatDate(sub.renewalDate)}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <SegmentedControl
            value={decision}
            onChange={setDecision}
            ariaLabel="Decision"
            options={[
              { value: "renewed", label: "Renew" },
              { value: "changed", label: "Change plan" },
              { value: "cancelled", label: "Cancel" },
            ]}
          />
          {decision === "changed" && (
            <Field label={`New cost (${sub.cost.currency})`} htmlFor="rd-cost" error={costOk ? undefined : "Enter an amount"}>
              <Input id="rd-cost" inputMode="decimal" className="font-mono" value={newCost} onChange={(e) => setNewCost(e.target.value)} />
            </Field>
          )}
          {decision === "cancelled" && (
            <p className="rounded-lg border border-warning/40 bg-warning/12 px-3 py-2 text-[12.5px]">
              Make sure nothing depends on it first. For example, cancelling an outreach domain stops its mailboxes.
            </p>
          )}
          <Field label="Note (optional)" htmlFor="rd-note">
            <Textarea id="rd-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why, and anything to remember next time" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={run} disabled={!costOk} loading={decide.isPending} variant={decision === "cancelled" ? "destructive" : "default"}>
            Save decision
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Manual usage reading for providers without an API (plan §18: "entered manually when no API is available"). */
export function UsageReadingDialog({ sub, onClose }: { sub: Subscription; onClose: () => void }) {
  const add = useAddUsageReading();
  const [value, setValue] = React.useState(String(sub.usage?.used ?? ""));
  const ok = /^\d+$/.test(value);
  const run = async () => {
    try {
      await add.mutateAsync({ id: sub.id, used: Number(value) });
      toast.success("Reading saved", { description: `${sub.vendor}: ${formatNumber(Number(value))} ${sub.usage?.unit ?? ""}` });
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the reading.");
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add a reading · {sub.vendor}</DialogTitle>
          <DialogDescription>This provider has no usage API, so the value is typed in. Your name is saved with it.</DialogDescription>
        </DialogHeader>
        <Field label={`${sub.usage?.metric ?? "Usage"}${sub.usage?.limit ? ` (limit ${formatNumber(sub.usage.limit)})` : ""}`} htmlFor="ur-val" error={ok || !value ? undefined : "Whole number"}>
          <Input id="ur-val" inputMode="numeric" className="font-mono" autoFocus value={value} onChange={(e) => setValue(e.target.value.trim())} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} disabled={!ok} loading={add.isPending}>
            Save reading
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
