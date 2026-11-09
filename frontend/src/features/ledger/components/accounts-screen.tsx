"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronDown, ListTree, Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Can, RequireAccess } from "@/components/shared/can";
import { Money } from "@/components/shared/money";
import { ErrorState, ListSkeleton } from "@/components/shared/states";
import { cn } from "@/lib/utils";
import type { Currency } from "@/types";
import { useAccounts, useCreateAccount } from "../hooks";
import { GROUP_CODE, GROUP_LABEL, GROUP_ORDER } from "../logic";
import type { Account, AccountGroup } from "../types";
import { FinanceRoleNote } from "./ledger-bits";

export function AccountsScreen() {
  return (
    <RequireAccess permission="finance.view" mode="404">
      <Accounts />
    </RequireAccess>
  );
}

const GROUP_COLOR: Record<AccountGroup, string> = {
  asset: "var(--chart-1)",
  liability: "var(--chart-3)",
  equity: "var(--chart-4)",
  income: "var(--chart-2)",
  expense: "var(--chart-5)",
};

function Accounts() {
  const q = useAccounts();
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const [adding, setAdding] = React.useState(false);
  const accounts = q.data ?? [];
  const needle = search.trim().toLowerCase();
  const matches = (a: Account) => !needle || a.code.includes(needle) || a.name.toLowerCase().includes(needle);

  const childrenOf = (id: string) => accounts.filter((a) => a.parentId === id);

  const renderRows = (parentId: string, depth: number): React.ReactNode[] =>
    childrenOf(parentId).flatMap((a) => {
      const kids = childrenOf(a.id);
      const visibleKids = kids.filter((k) => matches(k));
      if (!matches(a) && !visibleKids.length) return [];
      return [
        <li
          key={a.id}
          className={cn("grid grid-cols-[1fr_auto] items-center gap-3 border-b border-border px-5 py-2 last:border-0", a.isHeader && "bg-muted/40")}
          style={{ paddingLeft: 20 + depth * 22 }}
        >
          <span className="flex min-w-0 items-center gap-3">
            <span className="w-11 shrink-0 font-mono text-[12.5px] text-muted-foreground">{a.code}</span>
            <span className={cn("truncate text-[13.5px]", a.isHeader ? "font-semibold" : "font-medium")}>{a.name}</span>
            {a.currency === "USD" && <Badge tone="info">USD</Badge>}
            {a.isBank && <Badge tone="outline">Bank</Badge>}
            {a.kind === "accumulated_depreciation" && <Badge tone="outline">Contra</Badge>}
          </span>
          <span className="grid justify-items-end leading-tight">
            <Money value={a.balance} exact className={cn("text-[13px]", a.isHeader && "font-semibold")} />
            {a.foreignBalance && <Money value={a.foreignBalance} exact className="text-[11.5px] text-muted-foreground" />}
          </span>
        </li>,
        ...(a.isHeader ? renderRows(a.id, depth + 1) : []),
      ];
    });

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description="Five groups with number codes. The finance person sets these up; balances come from posted entries only."
        seal="confidential"
        actions={
          <Can permission="finance.entry_create">
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add account
            </Button>
          </Can>
        }
      />
      <FinanceRoleNote className="mb-4" prepares="sets up the chart of accounts" />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-80">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find by code or name" className="pl-8" aria-label="Find account" />
        </div>
        <Button variant="ghost" size="sm" onClick={() => setOpen(Object.fromEntries(GROUP_ORDER.map((g) => [g, false])))}>
          Collapse all
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen({})}>
          Expand all
        </Button>
        <Link href="/finance/statements?type=trial-balance" className="ml-auto text-[13px] font-medium text-primary hover:underline">
          Open the trial balance
        </Link>
      </div>

      {q.isPending ? (
        <ListSkeleton rows={10} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="grid gap-4">
          {GROUP_ORDER.map((g) => {
            const root = accounts.find((a) => a.code === GROUP_CODE[g]);
            if (!root) return null;
            const rows = renderRows(root.id, 0);
            if (needle && !rows.length) return null;
            const isOpen = open[g] !== false || !!needle;
            return (
              <Card key={g} className="overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [g]: !isOpen }))}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition hover:bg-muted/40"
                >
                  <span className="flex items-center gap-3">
                    <span className="h-7 w-1.5 rounded-full" style={{ background: GROUP_COLOR[g] }} aria-hidden />
                    <span className="font-mono text-[13px] text-muted-foreground">{root.code}</span>
                    <span className="text-[15px] font-semibold">{GROUP_LABEL[g]}</span>
                    <span className="text-[12px] text-muted-foreground">{accounts.filter((a) => a.group === g && !a.isHeader).length} accounts</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <Money value={root.balance} exact className="text-[14px] font-semibold" />
                    <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !isOpen && "-rotate-90")} />
                  </span>
                </button>
                {isOpen && <ul className="border-t border-border">{rows}</ul>}
              </Card>
            );
          })}
          <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <ListTree className="size-4" /> Income and expense balances are for all time; the income statement shows them for any period.
          </p>
        </div>
      )}
      {adding && <AddAccountDialog accounts={accounts} onClose={() => setAdding(false)} />}
    </>
  );
}

function AddAccountDialog({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const create = useCreateAccount();
  const [group, setGroup] = React.useState<AccountGroup>("expense");
  const [code, setCode] = React.useState("");
  const [name, setName] = React.useState("");
  const [parentOverride, setParentId] = React.useState<string | null>(null);
  const [currency, setCurrency] = React.useState<Currency>("PKR");
  const prefix = GROUP_CODE[group][0];
  const headers = accounts.filter((a) => a.isHeader && a.group === group);
  const codeError = code && (!/^\d{4}$/.test(code) ? "Use 4 digits" : code[0] !== prefix ? `${GROUP_LABEL[group]} codes start with ${prefix}` : accounts.some((a) => a.code === code) ? "This code is already used" : undefined);
  const valid = code && !codeError && name.trim().length >= 3;

  const parentId = parentOverride ?? accounts.find((a) => a.code === GROUP_CODE[group])?.id ?? "";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an account</DialogTitle>
          <DialogDescription>The finance person adds new accounts. Codes follow the group: 1000 assets, 2000 liabilities, 3000 equity, 4000 income, 5000 expenses.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!valid) return;
            try {
              await create.mutateAsync({ code, name: name.trim(), group, parentId: parentId || undefined, currency });
              toast.success(`Account ${code} · ${name.trim()} added`, { description: "The change is saved in the audit log." });
              onClose();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Couldn't add the account.");
            }
          }}
        >
          <Field label="Group">
            <NativeSelect
              value={group}
              onChange={(e) => {
                setGroup(e.target.value as AccountGroup);
                setParentId(null);
              }}
            >
              {GROUP_ORDER.map((g) => (
                <option key={g} value={g}>
                  {GROUP_CODE[g]} · {GROUP_LABEL[g]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
            <Field label="Code" htmlFor="acc-code" required error={codeError || undefined}>
              <Input id="acc-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder={`${prefix}…`} className="font-mono" />
            </Field>
            <Field label="Name" htmlFor="acc-name" required>
              <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Training and courses" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Under">
              <NativeSelect value={parentId} onChange={(e) => setParentId(e.target.value)}>
                {headers.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.code} · {h.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Currency">
              <SegmentedControl value={currency} onChange={setCurrency} options={[{ value: "PKR", label: "PKR" }, { value: "USD", label: "USD" }]} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid} loading={create.isPending}>
              Add account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
