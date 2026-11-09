"use client";
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { HandCoins, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Progress } from "@/components/ui/misc";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { RequireAccess } from "@/components/shared/can";
import { StatusBadge } from "@/components/shared/chips";
import { DataTable } from "@/components/shared/data-table";
import { EmpChip } from "@/components/shared/emp-chip";
import { StatCard } from "@/components/shared/metrics";
import { Money } from "@/components/shared/money";
import { EmployeeSelect } from "@/components/shared/pickers";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useCan } from "@/lib/auth/viewer";
import { formatMonthKey, monthKey } from "@/lib/dates";
import { formatMoney, toNumber } from "@/lib/format";
import { useAdvances, useCreateAdvance } from "../hooks";
import { nextMonthKey } from "../logic";
import type { SalaryAdvance } from "../types";

export function AdvancesScreen() {
  return (
    <RequireAccess permission="payroll.view" mode="404">
      <AdvancesInner />
    </RequireAccess>
  );
}

function AdvancesInner() {
  const q = useAdvances();
  const canCreate = useCan("payroll.prepare");
  const lookup = useLookup();
  const [open, setOpen] = React.useState(false);
  const list = q.data ?? [];
  const active = list.filter((a) => a.status === "active");
  const outstanding = active.reduce((s, a) => s + toNumber(a.remaining), 0);
  const monthly = active.reduce((s, a) => s + Math.min(toNumber(a.monthlyDeduction), toNumber(a.remaining)), 0);

  return (
    <>
      <PageHeader
        back={{ href: "/payroll", label: "Payroll" }}
        title="Salary advances"
        description="Advances are repaid automatically from each month's payroll until the balance is zero."
        seal="highly"
        actions={
          canCreate && (
            <Button onClick={() => setOpen(true)}>
              <Plus /> New advance
            </Button>
          )
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Active advances" value={active.length} icon={<HandCoins />} accent="var(--zone-finance)" />
        <StatCard label="Still to recover" value={<Money value={outstanding} compact />} accent="var(--zone-finance)" />
        <StatCard label="Deducted next payroll" value={<Money value={monthly} compact />} accent="var(--zone-finance)" />
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <DataTable<SalaryAdvance>
          rows={q.data}
          loading={q.isPending}
          rowKey={(a) => a.id}
          searchable
          searchPlaceholder="Search by name or reason"
          searchText={(a) => `${lookup.employee(a.empId)?.name ?? ""} ${a.empId} ${a.reason}`}
          initialSort={{ key: "status", dir: "asc" }}
          empty={<EmptyState icon={<HandCoins />} title="No salary advances" description="Advances recorded by the finance duty person appear here." />}
          columns={[
            { key: "emp", header: "Employee", cell: (a) => <EmpChip empId={a.empId} size="sm" />, sortValue: (a) => lookup.employee(a.empId)?.name ?? a.empId },
            { key: "amount", header: "Advance", align: "right", cell: (a) => <Money value={a.amount} />, sortValue: (a) => toNumber(a.amount) },
            { key: "monthly", header: "Per month", align: "right", cell: (a) => <Money value={a.monthlyDeduction} /> },
            { key: "start", header: "From", cell: (a) => formatMonthKey(a.startMonth), sortValue: (a) => a.startMonth, hideOnMobile: true },
            {
              key: "progress",
              header: "Repaid",
              width: "180px",
              hideOnMobile: true,
              cell: (a) => {
                const paid = toNumber(a.amount) - toNumber(a.remaining);
                return (
                  <div className="grid gap-1">
                    <Progress value={paid} max={toNumber(a.amount)} barClassName="bg-success" label="Repaid" />
                    <span className="text-[11.5px] text-muted-foreground tabular">{Math.round((paid / toNumber(a.amount)) * 100)}%</span>
                  </div>
                );
              },
            },
            { key: "remaining", header: "Left", align: "right", cell: (a) => <Money value={a.remaining} className="font-semibold" />, sortValue: (a) => toNumber(a.remaining) },
            { key: "status", header: "Status", cell: (a) => <StatusBadge label={a.status === "active" ? "Active" : "Repaid"} tone={a.status === "active" ? "warning" : "success"} />, sortValue: (a) => a.status },
            { key: "reason", header: "Reason", cell: (a) => <span className="text-muted-foreground">{a.reason}</span>, hideOnMobile: true },
          ]}
        />
      )}
      <NewAdvanceSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

const schema = z
  .object({
    empId: z.string().min(1, "Choose a person"),
    amount: z.string().refine((v) => Number(v) > 0, "Enter the advance amount"),
    monthly: z.string().refine((v) => Number(v) > 0, "Enter the monthly deduction"),
    startMonth: z.string().regex(/^\d{4}-\d{2}$/, "Choose the first month"),
    reason: z.string().trim().min(3, "Write a short reason"),
  })
  .refine((v) => Number(v.monthly) <= Number(v.amount), { path: ["monthly"], message: "Can't be more than the advance" });

type FormValues = z.infer<typeof schema>;

function NewAdvanceSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateAdvance();
  const lookup = useLookup();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: "onBlur",
    defaultValues: { empId: "", amount: "", monthly: "", startMonth: nextMonthKey(monthKey()), reason: "" },
  });
  const { register, handleSubmit, watch, setValue, formState, reset } = form;
  const amount = Number(watch("amount")) || 0;
  const monthly = Number(watch("monthly")) || 0;
  const start = watch("startMonth");
  const empId = watch("empId");

  const schedule = React.useMemo(() => {
    if (!amount || !monthly || monthly > amount || !/^\d{4}-\d{2}$/.test(start)) return [];
    const out: { month: string; deduct: number; left: number }[] = [];
    let left = amount;
    let m = start;
    while (left > 0 && out.length < 36) {
      const d = Math.min(monthly, left);
      left -= d;
      out.push({ month: m, deduct: d, left });
      m = nextMonthKey(m);
    }
    return out;
  }, [amount, monthly, start]);

  const onSubmit = handleSubmit(async (v) => {
    await create.mutateAsync({ empId: v.empId, amount: Number(v.amount), monthlyDeduction: Number(v.monthly), startMonth: v.startMonth, reason: v.reason });
    toast.success("Advance recorded", { description: `${formatMoney(Number(v.amount))} for ${lookup.employee(v.empId)?.name}. Deducted from ${formatMonthKey(v.startMonth)} payroll.` });
    reset();
    onOpenChange(false);
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="md">
        <SheetHeader>
          <SheetTitle>New salary advance</SheetTitle>
          <SheetDescription>The monthly amount is deducted from payroll automatically.</SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <SheetBody className="grid content-start gap-4">
            <Field label="Employee" htmlFor="adv-emp" error={formState.errors.empId?.message} required>
              <EmployeeSelect id="adv-emp" value={empId} onChange={(v) => setValue("empId", v, { shouldValidate: true })} filter={(e) => e.level > 2} invalid={!!formState.errors.empId} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Advance (PKR)" htmlFor="adv-amount" error={formState.errors.amount?.message} required>
                <Input id="adv-amount" inputMode="decimal" className="font-mono" placeholder="60000" {...register("amount")} aria-invalid={!!formState.errors.amount} />
              </Field>
              <Field label="Deduct per month" htmlFor="adv-monthly" error={formState.errors.monthly?.message} required>
                <Input id="adv-monthly" inputMode="decimal" className="font-mono" placeholder="10000" {...register("monthly")} aria-invalid={!!formState.errors.monthly} />
              </Field>
            </div>
            <Field label="First deduction" htmlFor="adv-start" error={formState.errors.startMonth?.message} required>
              <Input id="adv-start" type="month" {...register("startMonth")} />
            </Field>
            <Field label="Reason" htmlFor="adv-reason" error={formState.errors.reason?.message} required>
              <Textarea id="adv-reason" placeholder="e.g. Family medical expense" {...register("reason")} />
            </Field>
            <div className="rounded-xl border border-border bg-muted/40 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Repayment plan</p>
              {schedule.length ? (
                <>
                  <p className="mt-1 text-[13px]">
                    {schedule.length} month{schedule.length > 1 ? "s" : ""}, last deduction in <span className="font-medium">{formatMonthKey(schedule[schedule.length - 1].month)}</span>.
                  </p>
                  <ul className="mt-3 grid gap-1 text-[12.5px]">
                    {schedule.slice(0, 6).map((s) => (
                      <li key={s.month} className="flex justify-between border-b border-dashed border-border py-1 last:border-0">
                        <span>{formatMonthKey(s.month)}</span>
                        <span className="flex gap-4">
                          <Money value={-s.deduct} />
                          <span className="w-28 text-right text-muted-foreground">
                            left <Money value={s.left} />
                          </span>
                        </span>
                      </li>
                    ))}
                    {schedule.length > 6 && <li className="pt-1 text-muted-foreground">…and {schedule.length - 6} more months</li>}
                  </ul>
                </>
              ) : (
                <p className="mt-1 text-[13px] text-muted-foreground">Enter the amount and monthly deduction to see the plan.</p>
              )}
            </div>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Record advance
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
