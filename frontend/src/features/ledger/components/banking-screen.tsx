"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, ArrowRightLeft, Check, CircleDashed, Landmark, Link2, Plus, Sparkles, Unlink, Upload, Wallet } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Can, RequireAccess } from "@/components/shared/can";
import { DataTable, type Column } from "@/components/shared/data-table";
import { MaskedValue } from "@/components/shared/masked-value";
import { Money, Mono } from "@/components/shared/money";
import { CardsSkeleton, EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { useCan, useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateShort, formatMonthKey } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { Currency } from "@/types";
import { isTopLevelRole } from "@/types";
import {
  useAcceptSuggestions, useAccounts, useBankAccounts, useCreateTransfer, useEntryFromStatement, useImportStatement, useMatchLine, usePeriods,
  useRates, useReconciliation, useTransfers,
} from "../hooks";
import { monthKeyOf, num } from "../logic";
import type { Account, BankStatementLine, JournalEntry, LedgerCashLine } from "../types";
import { AccountPicker } from "./account-picker";
import { EntryAmount, EntryStatusBadge, FinanceRoleNote } from "./ledger-bits";

type Tab = "accounts" | "transfers" | "reconcile";

export function BankingScreen() {
  return (
    <RequireAccess permission="finance.view" mode="404">
      <Banking />
    </RequireAccess>
  );
}

function Banking() {
  const [tab, setTab] = useUrlState<Tab>("tab", "accounts");
  return (
    <>
      <PageHeader title="Banking" description="Bank balances, transfers between accounts and the monthly bank reconciliation." seal="highly" />
      <FinanceRoleNote className="mb-4" prepares="records transfers and reconciles the bank" />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="accounts"><Landmark /> Accounts</TabsTrigger>
          <TabsTrigger value="transfers"><ArrowRightLeft /> Transfers</TabsTrigger>
          <TabsTrigger value="reconcile"><Link2 /> Reconcile</TabsTrigger>
        </TabsList>
        <TabsContent value="accounts"><BankAccountsTab /></TabsContent>
        <TabsContent value="transfers"><TransfersTab /></TabsContent>
        <TabsContent value="reconcile"><ReconcileTab /></TabsContent>
      </Tabs>
    </>
  );
}

/* ---------------- Accounts ---------------- */

function BankAccountsTab() {
  const q = useBankAccounts();
  const viewer = useViewer();
  const router = useRouter();
  // Full bank account numbers: the Director and the CEO / Founder / Owner (view) only.
  const canReveal = !!viewer && (isTopLevelRole(viewer.employee.role) || viewer.employee.role === "director");
  if (q.isPending) return <CardsSkeleton count={4} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const total = q.data.reduce((s, a) => s + num(a.balance.amount), 0);
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {q.data.map((a) => (
          <Card key={a.id} className="relative overflow-hidden">
            <span className="absolute inset-x-0 top-0 h-1" style={{ background: a.currency === "USD" ? "var(--chart-2)" : "var(--zone-finance)" }} aria-hidden />
            <CardHeader className="pb-1">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-muted-foreground">{a.bankName ?? "Cash"}</p>
                <CardTitle className="truncate">{a.name}</CardTitle>
              </div>
              <span className="grid size-9 shrink-0 place-content-center rounded-lg bg-muted text-muted-foreground">{a.isBank ? <Landmark className="size-4" /> : <Wallet className="size-4" />}</span>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div>
                {a.foreignBalance ? (
                  <>
                    <Money value={a.foreignBalance} exact className="text-[22px] font-semibold" />
                    <p className="text-[12px] text-muted-foreground">
                      Book value <Money value={a.balance} exact />
                    </p>
                  </>
                ) : (
                  <Money value={a.balance} exact className="text-[22px] font-semibold" />
                )}
              </div>
              <div className="flex items-center justify-between gap-2 text-[12.5px]">
                {a.bankAccountNumber ? <MaskedValue value={a.bankAccountNumber} canReveal={canReveal} stepUp label="account number" /> : <span className="text-muted-foreground">Petty cash box</span>}
                {a.isBank && a.currency === "PKR" && (
                  <Button size="sm" variant="ghost" onClick={() => router.replace(`/finance/banking?tab=reconcile&account=${a.id}`, { scroll: false })}>
                    Reconcile <ArrowRight />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="text-[13px] text-muted-foreground">
        Cash and bank in total: <Money value={total} exact className="font-semibold text-foreground" />. Balances include posted entries only.
      </p>
    </div>
  );
}

/* ---------------- Transfers ---------------- */

function TransfersTab() {
  const router = useRouter();
  const q = useTransfers();
  const accounts = useAccounts();
  const [open, setOpen] = React.useState(false);
  const name = (id?: string) => accounts.data?.find((a) => a.id === id)?.name ?? "—";
  const fromTo = (e: JournalEntry) => ({ from: e.lines.find((l) => num(l.credit) > 0)?.accountId, to: e.lines.find((l) => num(l.debit) > 0)?.accountId });
  const columns: Column<JournalEntry>[] = [
    { key: "number", header: "Entry", cell: (e) => <Mono className="whitespace-nowrap text-[12.5px]">{e.number}</Mono>, sortValue: (e) => e.number },
    { key: "date", header: "Date", cell: (e) => formatDate(e.date), sortValue: (e) => e.date },
    {
      key: "route",
      header: "From → to",
      cell: (e) => {
        const r = fromTo(e);
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            {name(r.from)} <ArrowRight className="size-3.5 text-muted-foreground" /> {name(r.to)}
          </span>
        );
      },
    },
    { key: "amount", header: "Amount", align: "right", cell: (e) => <EntryAmount entry={e} />, sortValue: (e) => num(e.baseTotal.amount) },
    { key: "status", header: "Status", cell: (e) => <EntryStatusBadge status={e.status} /> },
  ];
  return (
    <>
      <DataTable
        rows={q.data}
        loading={q.isPending}
        columns={columns}
        rowKey={(e) => e.id}
        onRowClick={(e) => router.push(`/finance/ledger/${e.id}`)}
        toolbar={
          <Can permission="finance.entry_create">
            <Button onClick={() => setOpen(true)} className="ml-auto">
              <Plus /> New transfer
            </Button>
          </Can>
        }
        empty={<EmptyState icon={<ArrowRightLeft />} title="No transfers yet" />}
      />
      {open && <TransferDialog accounts={accounts.data ?? []} onClose={() => setOpen(false)} />}
    </>
  );
}

function TransferDialog({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const create = useCreateTransfer();
  const rates = useRates();
  const banks = accounts.filter((a) => a.kind === "cash" && !a.isHeader);
  const [fromId, setFrom] = React.useState("acc-1130");
  const [toId, setTo] = React.useState("acc-1110");
  const [amount, setAmount] = React.useState("");
  const [note, setNote] = React.useState("");
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const from = banks.find((a) => a.id === fromId);
  const currency: Currency = from?.currency ?? "PKR";
  const rate = rates.data?.[rates.data.length - 1]?.rate ?? "283";
  const invalid = fromId === toId || !(Number(amount) > 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer between accounts</DialogTitle>
          <DialogDescription>Creates an entry that goes for approval. USD leaves Payoneer at the book rate; the difference is posted as an exchange gain or loss.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
            <Field label="From">
              <NativeSelect value={fromId} onChange={(e) => setFrom(e.target.value)}>
                {banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </NativeSelect>
            </Field>
            <ArrowRight className="mb-2.5 hidden size-4 text-muted-foreground sm:block" />
            <Field label="To" error={fromId === toId ? "Choose another account" : undefined}>
              <NativeSelect value={toId} onChange={(e) => setTo(e.target.value)}>
                {banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </NativeSelect>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={`Amount (${currency})`} htmlFor="tr-amt">
              <Input id="tr-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} className="text-right font-mono" />
            </Field>
            <Field label="Date" htmlFor="tr-date">
              <Input id="tr-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Rate" hint={currency === "USD" ? "PKR per USD" : "PKR"}>
              <Input value={currency === "USD" ? rate : "1.00"} disabled className="font-mono" />
            </Field>
          </div>
          <Field label="Note" htmlFor="tr-note">
            <Input id="tr-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Funds for November payroll" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={invalid}
            loading={create.isPending}
            onClick={async () => {
              try {
                const e = await create.mutateAsync({ fromId, toId, amount: Number(amount), currency, rate, date: new Date(`${date}T12:00:00`).toISOString(), note });
                toast.success(`Transfer ${e.number} sent for approval`);
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Couldn't create the transfer.");
              }
            }}
          >
            Create transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Reconcile ---------------- */

function parseStatementCsv(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
  const at = (k: string) => header.findIndex((h) => h.includes(k));
  const iDate = at("date");
  const iDesc = Math.max(at("desc"), at("narration"));
  const iAmt = at("amount");
  const iDr = Math.max(at("withdraw"), at("debit"));
  const iCr = Math.max(at("deposit"), at("credit"));
  return lines.slice(1).flatMap((l) => {
    const c = l.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    const d = new Date(c[iDate]);
    if (Number.isNaN(d.getTime())) return [];
    const amount = iAmt >= 0 ? Number(c[iAmt]) : Number(c[iCr] || 0) - Number(c[iDr] || 0);
    if (Number.isNaN(amount)) return [];
    d.setHours(12);
    return [{ date: d.toISOString(), description: c[iDesc] ?? "", amount }];
  });
}

function ReconcileTab() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const canEdit = useCan("finance.entry_create");
  const banks = useBankAccounts();
  const periods = usePeriods();
  const bankId = params.get("account") ?? "acc-1110";
  const month = params.get("month") ?? monthKeyOf(new Date());
  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params.toString());
    p.set(k, v);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  const q = useReconciliation(bankId, month);
  const match = useMatchLine();
  const accept = useAcceptSuggestions();
  const importer = useImportStatement();
  const [creating, setCreating] = React.useState<BankStatementLine | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const stmt = q.data?.statement ?? [];
  const ledger = q.data?.ledger ?? [];
  const byKey = new Map(ledger.map((l) => [l.key, l]));
  const matched = stmt.filter((s) => s.matchedLineKey).length;
  const suggestions = stmt.filter((s) => !s.matchedLineKey && s.suggestion && !s.suggestion.startsWith("entry:")).length;
  const missing = stmt.filter((s) => !s.matchedLineKey && !s.suggestion);
  const outstanding = ledger.filter((l) => !l.matched);
  const done = stmt.length > 0 && matched === stmt.length;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Bank account" className="w-64">
          <NativeSelect value={bankId} onChange={(e) => setParam("account", e.target.value)}>
            {(banks.data ?? []).filter((a) => a.isBank && a.currency === "PKR").map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Month" className="w-48">
          <NativeSelect value={month} onChange={(e) => setParam("month", e.target.value)}>
            {(periods.data ?? []).map((p) => (
              <option key={p.month} value={p.month}>{formatMonthKey(p.month)}{p.status === "closed" ? " (closed)" : ""}</option>
            ))}
          </NativeSelect>
        </Field>
        <div className="ml-auto flex flex-wrap gap-2">
          {canEdit && suggestions > 0 && (
            <Button variant="outline" loading={accept.isPending} onClick={async () => { const n = await accept.mutateAsync({ bankAccountId: bankId, month }); toast.success(`${n} line${n === 1 ? "" : "s"} matched`); }}>
              <Sparkles /> Accept {suggestions} suggested match{suggestions === 1 ? "" : "es"}
            </Button>
          )}
          {canEdit && (
            <>
              <Button variant="outline" onClick={() => fileRef.current?.click()} loading={importer.isPending}>
                <Upload /> Import statement (CSV)
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const rows = parseStatementCsv(await f.text());
                  if (!rows.length) return toast.error("No lines found", { description: "Use columns: date, description, amount (or withdrawal and deposit)." });
                  const n = await importer.mutateAsync({ bankAccountId: bankId, rows });
                  toast.success(`${n} statement lines imported`);
                }}
              />
            </>
          )}
        </div>
      </div>

      {q.isPending ? (
        <ListSkeleton rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={done ? "success" : "warning"} dot>{done ? "Reconciled" : "Not reconciled"}</Badge>
            <span className="text-muted-foreground">{stmt.length} statement lines · {matched} matched · {missing.length} missing in the ledger · {outstanding.length} ledger lines not on the statement</span>
          </div>
          {!stmt.length ? (
            <EmptyState
              icon={<Upload />}
              title="No bank statement for this month"
              description={periods.data?.find((p) => p.month === month)?.status === "closed" ? "This month was reconciled when it was closed." : "Download the statement from internet banking as CSV and import it here."}
            />
          ) : (
            <div className="grid gap-5 xl:grid-cols-2">
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Bank statement</CardTitle>
                  <span className="text-[12px] text-muted-foreground">What the bank says</span>
                </CardHeader>
                <ul className="divide-y divide-border border-t border-border">
                  {stmt.map((s) => {
                    const m = s.matchedLineKey ? byKey.get(s.matchedLineKey) : undefined;
                    const sug = s.suggestion && !s.suggestion.startsWith("entry:") ? byKey.get(s.suggestion) : undefined;
                    const created = s.suggestion?.startsWith("entry:") ? s.suggestion.slice(6) : undefined;
                    const candidates = outstanding.filter((l) => Math.sign(num(l.amount)) === Math.sign(num(s.amount)));
                    return (
                      <li key={s.id} className={cn("grid gap-2 px-5 py-3", m && "bg-success/5")}>
                        <div className="flex items-start justify-between gap-3">
                          <span className="grid leading-tight">
                            <span className="text-[13px] font-medium">{s.description}</span>
                            <span className="text-[11.5px] text-muted-foreground">{formatDateShort(s.date)}</span>
                          </span>
                          <Money value={num(s.amount)} exact sign tone="auto" className="text-[13px]" />
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                          {m ? (
                            <>
                              <Badge tone="success"><Check /> Matched <Mono>{m.entryNumber}</Mono></Badge>
                              {canEdit && <Button size="sm" variant="ghost" onClick={() => match.mutate({ statementLineId: s.id, lineKey: null })}><Unlink /> Unmatch</Button>}
                            </>
                          ) : sug ? (
                            <>
                              <Badge tone="info"><Sparkles /> Suggested <Mono>{sug.entryNumber}</Mono> · {formatDateShort(sug.date)}</Badge>
                              {canEdit && <Button size="sm" variant="outline" onClick={() => match.mutate({ statementLineId: s.id, lineKey: sug.key })}><Link2 /> Match</Button>}
                            </>
                          ) : created ? (
                            <Badge tone="warning"><CircleDashed /> Entry created, waiting for approval · <Link className="underline" href={`/finance/ledger/${created}`}>open</Link></Badge>
                          ) : (
                            <>
                              <Badge tone="danger">Missing in the ledger</Badge>
                              {canEdit && candidates.length > 0 && (
                                <NativeSelect className="w-56" value="" onChange={(e) => e.target.value && match.mutate({ statementLineId: s.id, lineKey: e.target.value })} aria-label="Match with a ledger line">
                                  <option value="">Match with…</option>
                                  {candidates.map((l) => <option key={l.key} value={l.key}>{l.entryNumber} · {num(l.amount).toLocaleString("en-PK")}</option>)}
                                </NativeSelect>
                              )}
                              {canEdit && <Button size="sm" variant="outline" onClick={() => setCreating(s)}><Plus /> Create entry</Button>}
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Ledger</CardTitle>
                  <span className="text-[12px] text-muted-foreground">Posted lines on this account</span>
                </CardHeader>
                <ul className="divide-y divide-border border-t border-border">
                  {ledger.map((l: LedgerCashLine) => (
                    <li key={l.key} className={cn("flex items-start justify-between gap-3 px-5 py-3", l.matched && "bg-success/5")}>
                      <span className="grid leading-tight">
                        <Link href={`/finance/ledger/${l.entryId}`} className="text-[13px] font-medium hover:underline">{l.description}</Link>
                        <span className="text-[11.5px] text-muted-foreground"><Mono>{l.entryNumber}</Mono> · {formatDateShort(l.date)}</span>
                      </span>
                      <span className="grid justify-items-end gap-1">
                        <Money value={num(l.amount)} exact sign tone="auto" className="text-[13px]" />
                        {l.matched ? <Badge tone="success"><Check /> On statement</Badge> : <Badge tone="outline">Not on statement yet</Badge>}
                      </span>
                    </li>
                  ))}
                  {!ledger.length && <li className="px-5 py-8 text-center text-[13px] text-muted-foreground">No posted lines this month.</li>}
                </ul>
              </Card>
            </div>
          )}
        </>
      )}
      {creating && <CreateFromStatementDialog line={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}

function CreateFromStatementDialog({ line, onClose }: { line: BankStatementLine; onClose: () => void }) {
  const accounts = useAccounts();
  const create = useEntryFromStatement();
  const inflow = num(line.amount) > 0;
  const [counter, setCounter] = React.useState(inflow ? "acc-4800" : "acc-5850");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an entry for this bank line</DialogTitle>
          <DialogDescription>
            “{line.description}” · <Money value={num(line.amount)} exact sign />. The entry goes for approval; once posted it is matched automatically.
          </DialogDescription>
        </DialogHeader>
        <Field label={inflow ? "Credit this account (where the money came from)" : "Debit this account (what the money was for)"}>
          <AccountPicker accounts={accounts.data ?? []} value={counter} onChange={setCounter} filter={(a) => a.id !== line.bankAccountId} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            loading={create.isPending}
            onClick={async () => {
              const e = await create.mutateAsync({ statementLineId: line.id, counterAccountId: counter });
              toast.success(`${e.number} sent for approval`);
              onClose();
            }}
          >
            Create entry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
