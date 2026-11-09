"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Building2, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Can, RequireAccess } from "@/components/shared/can";
import { DataTable, type Column } from "@/components/shared/data-table";
import { Money, Mono } from "@/components/shared/money";
import { DetailList } from "@/components/shared/pickers";
import { EmptyState, ListSkeleton } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { formatDate } from "@/lib/dates";
import { toNumber } from "@/lib/format";
import type { Currency } from "@/types";
import { useBills, useCreateParty, useParties, usePartyEntries, useReceivables } from "../hooks";
import type { Party } from "../types";
import { EntryAmount, EntryStatusBadge } from "./ledger-bits";

export function PartiesScreen() {
  return (
    <RequireAccess permission="finance.view" mode="404">
      <Parties />
    </RequireAccess>
  );
}

function Parties() {
  const [tab, setTab] = useUrlState<"clients" | "vendors">("tab", "clients");
  const kind = tab === "clients" ? "client" : "vendor";
  const q = useParties();
  const receivables = useReceivables();
  const bills = useBills();
  const [selected, setSelected] = React.useState<Party | null>(null);
  const [adding, setAdding] = React.useState(false);
  const list = (q.data ?? []).filter((p) => p.kind === kind);

  const openDocs = (p: Party) =>
    p.kind === "client"
      ? (receivables.data ?? []).filter((r) => r.clientId === p.id && r.status !== "paid").length
      : (bills.data ?? []).filter((b) => b.vendorId === p.id && b.status !== "paid").length;

  const columns: Column<Party>[] = [
    {
      key: "name",
      header: kind === "client" ? "Client" : "Vendor",
      cell: (p) => (
        <span className="flex items-center gap-3">
          <Avatar name={p.name} hue={(p.name.charCodeAt(0) * 37) % 360} size={30} />
          <span className="grid leading-tight">
            <span className="font-medium">{p.name}</span>
            <span className="text-[11.5px] text-muted-foreground">{p.email}</span>
          </span>
        </span>
      ),
      sortValue: (p) => p.name,
    },
    { key: "country", header: "Country", cell: (p) => p.country ?? "—", sortValue: (p) => p.country ?? "", hideOnMobile: true },
    { key: "currency", header: "Currency", cell: (p) => <Badge tone={p.currency === "USD" ? "info" : "neutral"}>{p.currency}</Badge> },
    { key: "terms", header: "Terms", cell: (p) => <span className="text-muted-foreground">{p.terms ?? "—"}</span>, hideOnMobile: true },
    { key: "open", header: kind === "client" ? "Unpaid invoices" : "Unpaid bills", align: "right", cell: (p) => openDocs(p) || "—", sortValue: (p) => openDocs(p) },
    {
      key: "balance",
      header: kind === "client" ? "They owe us" : "We owe them",
      align: "right",
      cell: (p) => <Money value={p.balance} exact className={toNumber(p.balance) > 0 ? "font-semibold" : "text-muted-foreground"} />,
      sortValue: (p) => toNumber(p.balance),
    },
  ];

  return (
    <>
      <PageHeader
        title="Clients and vendors"
        description="Who Aceva bills and who Aceva pays. Balances come from the receivable and payable accounts in the ledger."
        seal="confidential"
        actions={
          <Can permission="finance.entry_create">
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add {kind}
            </Button>
          </Can>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as "clients" | "vendors")}>
        <TabsList className="mb-5">
          <TabsTrigger value="clients">Clients <Badge tone="outline">{(q.data ?? []).filter((p) => p.kind === "client").length}</Badge></TabsTrigger>
          <TabsTrigger value="vendors">Vendors <Badge tone="outline">{(q.data ?? []).filter((p) => p.kind === "vendor").length}</Badge></TabsTrigger>
        </TabsList>
      </Tabs>
      <DataTable
        rows={list}
        loading={q.isPending}
        columns={columns}
        rowKey={(p) => p.id}
        onRowClick={setSelected}
        searchable
        searchText={(p) => `${p.name} ${p.email} ${p.country}`}
        searchPlaceholder={`Search ${tab}`}
        initialSort={{ key: "balance", dir: "desc" }}
        empty={<EmptyState icon={<Building2 />} title={`No ${tab} yet`} />}
      />
      {selected && <PartySheet party={selected} onClose={() => setSelected(null)} />}
      {adding && <AddPartyDialog kind={kind} onClose={() => setAdding(false)} />}
    </>
  );
}

function PartySheet({ party, onClose }: { party: Party; onClose: () => void }) {
  const entries = usePartyEntries(party.id);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle>{party.name}</SheetTitle>
          <SheetDescription>{party.kind === "client" ? "Client" : "Vendor"} · {party.country}</SheetDescription>
        </SheetHeader>
        <SheetBody className="grid content-start gap-6">
          <DetailList
            columns={2}
            items={[
              ["Contact", party.contactName ?? "—"],
              ["Email", party.email ?? "—"],
              ["Currency", party.currency],
              ["Terms", party.terms ?? "—"],
              [party.kind === "client" ? "They owe us" : "We owe them", <Money key="b" value={party.balance} exact className="font-semibold" />],
            ]}
          />
          <div>
            <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground">Recent entries</p>
            {entries.isPending ? (
              <ListSkeleton rows={4} />
            ) : !entries.data?.length ? (
              <p className="text-[13px] text-muted-foreground">No entries yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {entries.data.map((e) => (
                  <li key={e.id}>
                    <Link href={`/finance/ledger/${e.id}`} className="flex items-center gap-3 px-3 py-2.5 transition hover:bg-muted/50">
                      <span className="grid min-w-0 flex-1 leading-tight">
                        <span className="truncate text-[13px] font-medium">{e.description}</span>
                        <span className="text-[11.5px] text-muted-foreground">
                          <Mono>{e.number}</Mono> · {formatDate(e.date)}
                        </span>
                      </span>
                      <EntryStatusBadge status={e.status} />
                      <EntryAmount entry={e} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function AddPartyDialog({ kind, onClose }: { kind: Party["kind"]; onClose: () => void }) {
  const create = useCreateParty();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [country, setCountry] = React.useState("Pakistan");
  const [currency, setCurrency] = React.useState<Currency>("PKR");
  const [terms, setTerms] = React.useState("Net 30");
  const emailOk = !email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a {kind}</DialogTitle>
          <DialogDescription>Used on entries, invoices and bills.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (name.trim().length < 2 || !emailOk) return;
            await create.mutateAsync({ kind, name: name.trim(), email: email || undefined, country, currency, terms });
            toast.success(`${name.trim()} added`);
            onClose();
          }}
        >
          <Field label="Name" htmlFor="pt-name" required>
            <Input id="pt-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Billing email" htmlFor="pt-email" error={!emailOk ? "Enter a valid email" : undefined}>
            <Input id="pt-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Country" htmlFor="pt-country">
              <Input id="pt-country" value={country} onChange={(e) => setCountry(e.target.value)} />
            </Field>
            <Field label="Currency">
              <SegmentedControl value={currency} onChange={setCurrency} options={[{ value: "PKR", label: "PKR" }, { value: "USD", label: "USD" }]} />
            </Field>
            <Field label="Terms">
              <NativeSelect value={terms} onChange={(e) => setTerms(e.target.value)}>
                {["Due on receipt", "Net 15", "Net 30", "Net 45", "Card on file", "Prepaid"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={name.trim().length < 2 || !emailOk} loading={create.isPending}>
              Add {kind}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
