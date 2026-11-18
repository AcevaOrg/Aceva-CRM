"use client";
import * as React from "react";
import Link from "next/link";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { AlarmClock, Banknote, Paperclip, Plus, Receipt, Wallet } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/overlays";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Can, RequireAccess } from "@/components/shared/can";
import { DeadlineChip, StatusBadge, statusMap } from "@/components/shared/chips";
import { DataTable, type Column } from "@/components/shared/data-table";
import { StatCard } from "@/components/shared/metrics";
import { Money, Mono } from "@/components/shared/money";
import { EmptyState } from "@/components/shared/states";
import { FileCard } from "@/components/shared/timeline";
import { useCan, useViewer } from "@/lib/auth/viewer";
import { formatDate } from "@/lib/dates";
import { formatMoneyCompact, toNumber } from "@/lib/format";
import { uid } from "@/lib/utils";
import type { Attachment } from "@/types";
import { useAccounts, useBankAccounts, useBills, useCreateBill, useParties, usePayBill } from "../hooks";
import { stashReceiptFile } from "../live-api";
import type { Bill } from "../types";
import { AccountPicker } from "./account-picker";
import { FinanceRoleNote } from "./ledger-bits";

const billStatus = statusMap<Bill["status"]>({
  unpaid: { label: "Unpaid", tone: "warning" },
  part_paid: { label: "Part paid", tone: "info" },
  paid: { label: "Paid", tone: "success" },
});

export function BillsScreen() {
  return (
    <RequireAccess permission="finance.view" mode="404">
      <Bills />
    </RequireAccess>
  );
}

function Bills() {
  const q = useBills();
  const parties = useParties("vendor");
  const accounts = useAccounts();
  const canPay = useCan("finance.entry_create");
  const [filter, setFilter] = React.useState<"open" | "all" | "paid">("open");
  const [adding, setAdding] = React.useState(false);
  const [paying, setPaying] = React.useState<Bill | null>(null);
  const [now] = React.useState(() => Date.now());
  const vendor = (id: string) => parties.data?.find((p) => p.id === id)?.name ?? id;
  const all = q.data ?? [];
  const open = all.filter((b) => b.status !== "paid");
  const outstanding = (b: Bill) => toNumber(b.total) - toNumber(b.paid);
  const week = now + 7 * 86_400_000;
  const dueSoon = open.filter((b) => new Date(b.dueDate).getTime() <= week && new Date(b.dueDate).getTime() >= now - 86_400_000);
  const overdue = open.filter((b) => new Date(b.dueDate).getTime() < now - 86_400_000);
  const rows = all.filter((b) => (filter === "open" ? b.status !== "paid" : filter === "paid" ? b.status === "paid" : true));

  const columns: Column<Bill>[] = [
    { key: "number", header: "Bill", cell: (b) => <Mono className="whitespace-nowrap text-[12.5px]">{b.number}</Mono>, sortValue: (b) => b.number },
    {
      key: "vendor",
      header: "Vendor",
      cell: (b) => (
        <span className="grid leading-tight">
          <span className="font-medium">{vendor(b.vendorId)}</span>
          <span className="text-[11.5px] text-muted-foreground">{b.description}</span>
        </span>
      ),
      sortValue: (b) => vendor(b.vendorId),
    },
    { key: "category", header: "Category", cell: (b) => <span className="text-muted-foreground">{accounts.data?.find((a) => a.id === b.categoryAccountId)?.name ?? "—"}</span>, hideOnMobile: true },
    { key: "date", header: "Bill date", cell: (b) => formatDate(b.date), sortValue: (b) => b.date, hideOnMobile: true },
    { key: "due", header: "Due", cell: (b) => <DeadlineChip deadline={b.dueDate} done={b.status === "paid"} />, sortValue: (b) => b.dueDate },
    { key: "total", header: "Total", align: "right", cell: (b) => <Money value={b.total} exact />, sortValue: (b) => toNumber(b.total) },
    { key: "out", header: "Outstanding", align: "right", cell: (b) => (outstanding(b) > 0 ? <Money value={outstanding(b)} exact className="font-semibold" /> : <span className="text-muted-foreground">—</span>), sortValue: outstanding },
    { key: "status", header: "Status", cell: (b) => <StatusBadge {...billStatus(b.status)} /> },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (b) => (
        <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {b.receipt && (
            <Tip content={`Receipt: ${b.receipt.fileName}`}>
              <Button size="icon-sm" variant="ghost" aria-label="Open receipt" onClick={() => toast("Opening a private link (expires in 5 minutes)", { description: b.receipt!.fileName })}>
                <Paperclip />
              </Button>
            </Tip>
          )}
          {canPay && b.status !== "paid" && (
            <Button size="sm" variant="outline" onClick={() => setPaying(b)}>
              Pay
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Bills and expenses"
        description="Vendor bills with their receipts. Every bill and payment becomes a ledger entry that goes through approval."
        seal="confidential"
        actions={
          <Can permission="finance.entry_create">
            <Button onClick={() => setAdding(true)}>
              <Plus /> New bill
            </Button>
          </Can>
        }
      />
      <FinanceRoleNote className="mb-4" prepares="records bills, receipts and payments" />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Unpaid" value={formatMoneyCompact(open.reduce((s, b) => s + outstanding(b), 0))} hint={`${open.length} bills`} icon={<Wallet />} accent="var(--zone-finance)" />
        <StatCard label="Due in the next 7 days" value={dueSoon.length} hint={formatMoneyCompact(dueSoon.reduce((s, b) => s + outstanding(b), 0))} icon={<AlarmClock />} accent="var(--warning)" />
        <StatCard label="Overdue" value={overdue.length} hint={overdue.length ? formatMoneyCompact(overdue.reduce((s, b) => s + outstanding(b), 0)) : "Nothing late"} icon={<Receipt />} accent={overdue.length ? "var(--danger)" : undefined} />
      </div>
      <DataTable
        rows={rows}
        loading={q.isPending}
        columns={columns}
        rowKey={(b) => b.id}
        searchable
        searchText={(b) => `${b.number} ${vendor(b.vendorId)} ${b.description}`}
        searchPlaceholder="Search bills"
        initialSort={{ key: "due", dir: "asc" }}
        toolbar={
          <SegmentedControl
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "open", label: "To pay" },
              { value: "paid", label: "Paid" },
              { value: "all", label: "All" },
            ]}
          />
        }
        empty={<EmptyState icon={<Receipt />} title={filter === "open" ? "No bills to pay" : "No bills"} description={filter === "open" ? "Everything is paid." : undefined} />}
      />
      {adding && <NewBillSheet onClose={() => setAdding(false)} />}
      {paying && <PayBillDialog bill={paying} vendor={vendor(paying.vendorId)} onClose={() => setPaying(null)} />}
    </>
  );
}

const billSchema = z
  .object({
    vendorId: z.string().min(1, "Choose a vendor"),
    date: z.string().min(1, "Required"),
    dueDate: z.string().min(1, "Required"),
    categoryAccountId: z.string().min(1, "Choose what the bill is for"),
    amount: z.coerce.number<string>().positive("Enter an amount above zero"),
    description: z.string().trim().min(3, "Describe the bill"),
  })
  .refine((v) => v.dueDate >= v.date, { message: "Due date can't be before the bill date", path: ["dueDate"] });

type BillForm = z.input<typeof billSchema>;
type BillOut = z.output<typeof billSchema>;

function ymdIn(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function NewBillSheet({ onClose }: { onClose: () => void }) {
  const viewer = useViewer();
  const vendors = useParties("vendor");
  const accounts = useAccounts();
  const create = useCreateBill();
  const [receipt, setReceipt] = React.useState<Attachment | undefined>();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const { register, handleSubmit, control, formState } = useForm<BillForm, unknown, BillOut>({
    resolver: zodResolver(billSchema),
    defaultValues: { vendorId: "", date: ymdIn(0), dueDate: ymdIn(30), categoryAccountId: "", amount: "", description: "" },
  });
  const e = formState.errors;

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle>New bill</SheetTitle>
          <SheetDescription>Saved with its receipt. The entry (expense against accounts payable) goes for approval.</SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={handleSubmit(async (v) => {
            try {
              const out = v;
              const bill = await create.mutateAsync({
                vendorId: out.vendorId,
                date: new Date(`${out.date}T12:00:00`).toISOString(),
                dueDate: new Date(`${out.dueDate}T12:00:00`).toISOString(),
                categoryAccountId: out.categoryAccountId,
                amount: out.amount,
                description: out.description,
                receipt,
              });
              toast.success(`${bill.number} saved`, { description: "Its ledger entry is waiting for approval." });
              onClose();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Couldn't save the bill.");
            }
          })}
        >
          <SheetBody className="grid content-start gap-4">
            <Field label="Vendor" htmlFor="b-vendor" required error={e.vendorId?.message}>
              <NativeSelect id="b-vendor" {...register("vendorId")} aria-invalid={!!e.vendorId}>
                <option value="">Choose a vendor</option>
                {(vendors.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="What it's for" htmlFor="b-desc" required error={e.description?.message}>
              <Input id="b-desc" {...register("description")} placeholder="e.g. LinkedIn ads for November" />
            </Field>
            <Field label="Expense or asset account" required error={e.categoryAccountId?.message} hint="Type a code or a name">
              <Controller
                control={control}
                name="categoryAccountId"
                render={({ field }) => (
                  <AccountPicker accounts={accounts.data ?? []} value={field.value} onChange={field.onChange} filter={(a) => a.group === "expense" || a.kind === "fixed_asset" || a.kind === "prepayment"} invalid={!!e.categoryAccountId} />
                )}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Amount (PKR)" htmlFor="b-amount" required error={e.amount?.message}>
                <Input id="b-amount" inputMode="decimal" {...register("amount")} className="text-right font-mono" />
              </Field>
              <Field label="Bill date" htmlFor="b-date" required error={e.date?.message}>
                <Input id="b-date" type="date" {...register("date")} />
              </Field>
              <Field label="Due date" htmlFor="b-due" required error={e.dueDate?.message}>
                <Input id="b-due" type="date" {...register("dueDate")} />
              </Field>
            </div>
            <Field label="Receipt" hint="PDF or photo of the bill">
              {receipt ? (
                <FileCard file={receipt} onOpen={() => setReceipt(undefined)} />
              ) : (
                <Button type="button" variant="outline" className="w-fit" onClick={() => fileRef.current?.click()}>
                  <Paperclip /> Upload receipt
                </Button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,image/*"
                className="hidden"
                onChange={(ev) => {
                  const f = ev.target.files?.[0];
                  if (f) {
                    const att = { id: uid("rc"), fileName: f.name, sizeBytes: f.size, mimeType: f.type, uploadedAt: new Date().toISOString(), uploadedBy: viewer?.employee.empId ?? "" };
                    stashReceiptFile(att.id, f); // live mode uploads the real file after the bill is saved
                    setReceipt(att);
                  }
                }}
              />
            </Field>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Save bill
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function PayBillDialog({ bill, vendor, onClose }: { bill: Bill; vendor: string; onClose: () => void }) {
  const banks = useBankAccounts();
  const pay = usePayBill();
  const outstanding = toNumber(bill.total) - toNumber(bill.paid);
  const [amount, setAmount] = React.useState(outstanding.toFixed(2));
  const [bank, setBank] = React.useState("acc-1120");
  const n = Number(amount);
  const invalid = !(n > 0 && n <= outstanding + 0.005);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <span className="mb-1 grid size-10 place-content-center rounded-xl bg-zone-finance/12 text-zone-finance">
            <Banknote className="size-5" />
          </span>
          <DialogTitle>Pay {bill.number}</DialogTitle>
          <DialogDescription>
            {vendor} · <Money value={outstanding} exact /> outstanding. The payment entry goes for approval before it posts.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Amount (PKR)" htmlFor="pay-amt" error={invalid ? `Between 1 and ${outstanding.toFixed(2)}` : undefined}>
            <Input id="pay-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="text-right font-mono" />
          </Field>
          <Field label="Pay from">
            <NativeSelect value={bank} onChange={(e) => setBank(e.target.value)}>
              {(banks.data ?? []).filter((a) => a.currency === "PKR").map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={invalid}
            loading={pay.isPending}
            onClick={async () => {
              try {
                const e = await pay.mutateAsync({ billId: bill.id, amount: n, bankAccountId: bank });
                toast.success(`Payment ${e.number} sent for approval`, { description: <Link href={`/finance/ledger/${e.id}`} className="underline">Open the entry</Link> });
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Couldn't record the payment.");
              }
            }}
          >
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
