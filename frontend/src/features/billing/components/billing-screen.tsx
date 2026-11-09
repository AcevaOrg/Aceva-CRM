"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, LayoutDashboard, Plus, Receipt, Users, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { Can, RequireAccess } from "@/components/shared/can";
import { DeadlineChip } from "@/components/shared/chips";
import { DataTable, type Column } from "@/components/shared/data-table";
import { useExport } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { Mono, Money } from "@/components/shared/money";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { INVOICE_STATUS, PAYMENT_METHOD, reminderSchedule } from "../logic";
import { useCustomerList, useCustomers, useInvoices, usePayments } from "../hooks";
import type { CustomerSummary, Invoice, InvoiceStatus, Payment } from "../types";
import { BillingOverviewPanel } from "./billing-overview";
import { InvoiceStatusBadge, InvoiceTypeLabel } from "./bits";

type Tab = "overview" | "invoices" | "customers" | "payments";

export function BillingScreen() {
  const [tab, setTab] = useUrlState<Tab>("tab", "overview");
  const exportData = useExport();
  return (
    <RequireAccess permission="billing.view" mode="404">
      <PageHeader
        title="Billing"
        description="Customer invoices, payments and reminders. Every invoice and payment is linked to the ledger."
        seal="confidential"
        actions={
          <>
            {/* Finance data exports are for the CEO / Founder / Owner and the Director. */}
            <Can permission="finance.export">
              <Button variant="outline" onClick={() => exportData({ title: "Invoice list", seal: "confidential", formats: ["xlsx", "csv", "pdf"] })}>
                <Download /> Export
              </Button>
            </Can>
            <Can permission="billing.manage">
              <Button asChild>
                <Link href="/billing/invoices/new">
                  <Plus /> New invoice
                </Link>
              </Button>
            </Can>
          </>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="overview">
            <LayoutDashboard /> Overview
          </TabsTrigger>
          <TabsTrigger value="invoices">
            <Receipt /> Invoices
          </TabsTrigger>
          <TabsTrigger value="customers">
            <Users /> Customers
          </TabsTrigger>
          <TabsTrigger value="payments">
            <Wallet /> Payments
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <BillingOverviewPanel />
        </TabsContent>
        <TabsContent value="invoices">
          <InvoicesTable />
        </TabsContent>
        <TabsContent value="customers">
          <CustomersTable />
        </TabsContent>
        <TabsContent value="payments">
          <PaymentsTable />
        </TabsContent>
      </Tabs>
    </RequireAccess>
  );
}

const FILTERS: ("all" | InvoiceStatus)[] = ["all", "draft", "sent", "part_paid", "overdue", "paid", "cancelled"];

function nextReminder(inv: Invoice) {
  if (!["sent", "part_paid", "overdue"].includes(inv.status)) return undefined;
  return reminderSchedule(inv.dueDate, inv.reminders).find((r) => r.date.getTime() > Date.now());
}

function InvoicesTable() {
  const q = useInvoices();
  const customers = useCustomerList();
  const router = useRouter();
  const [status, setStatus] = useUrlState<"all" | InvoiceStatus>("status", "all");
  const name = React.useCallback((id: string) => customers.data?.find((c) => c.id === id)?.name ?? "—", [customers.data]);
  const rows = (q.data ?? []).filter((i) => status === "all" || i.status === status);
  const counts = (s: "all" | InvoiceStatus) => (q.data ?? []).filter((i) => s === "all" || i.status === s).length;

  const columns: Column<Invoice>[] = [
    {
      key: "number",
      header: "Invoice",
      sortValue: (i) => i.number,
      cell: (i) => (
        <div className="grid gap-0.5">
          <Mono className="font-medium">{i.number}</Mono>
          {i.source && (
            <Badge tone="sales" className="w-fit">
              From {i.source.dealNumber}
            </Badge>
          )}
        </div>
      ),
    },
    { key: "customer", header: "Customer", sortValue: (i) => name(i.customerId), cell: (i) => <div className="grid"><span className="font-medium">{name(i.customerId)}</span><InvoiceTypeLabel invoice={i} /></div> },
    { key: "issued", header: "Issued", sortValue: (i) => i.issueDate, cell: (i) => <span className="tabular">{formatDate(i.issueDate)}</span>, hideOnMobile: true },
    {
      key: "due",
      header: "Due",
      sortValue: (i) => i.dueDate,
      cell: (i) => (["sent", "part_paid", "overdue"].includes(i.status) ? <DeadlineChip deadline={i.dueDate} /> : <span className="text-muted-foreground tabular">{formatDate(i.dueDate)}</span>),
    },
    { key: "total", header: "Total", align: "right", sortValue: (i) => Number(i.total.amount), cell: (i) => <Money value={i.total} exact /> },
    { key: "balance", header: "Balance", align: "right", sortValue: (i) => Number(i.balance.amount), cell: (i) => <Money value={i.balance} exact className={cn(Number(i.balance.amount) === 0 && "text-muted-foreground")} /> },
    { key: "status", header: "Status", sortValue: (i) => i.status, cell: (i) => <InvoiceStatusBadge status={i.status} /> },
    {
      key: "reminder",
      header: "Next reminder",
      hideOnMobile: true,
      cell: (i) => {
        const r = nextReminder(i);
        return r ? <span className="text-[12.5px] text-muted-foreground">{formatDate(r.date)} · {r.label.toLowerCase()}</span> : <span className="text-muted-foreground">—</span>;
      },
    },
  ];

  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  return (
    <DataTable
      rows={rows}
      loading={q.isPending}
      columns={columns}
      rowKey={(i) => i.id}
      onRowClick={(i) => router.push(`/billing/invoices/${i.id}`)}
      searchable
      searchText={(i) => `${i.number} ${name(i.customerId)} ${i.source?.dealNumber ?? ""}`}
      searchPlaceholder="Search invoice or customer"
      initialSort={{ key: "issued", dir: "desc" }}
      rowClassName={(i) => (i.status === "overdue" ? "bg-danger/[0.04]" : undefined)}
      toolbar={
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
          {FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              aria-pressed={status === s}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition",
                status === s ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {s === "all" ? "All" : INVOICE_STATUS[s].label}
              <span className="tabular text-[11px] text-muted-foreground">{counts(s)}</span>
            </button>
          ))}
        </div>
      }
      empty={<EmptyState compact icon={<Receipt />} title={status === "all" ? "No invoices yet" : `No ${INVOICE_STATUS[status as InvoiceStatus].label.toLowerCase()} invoices`} />}
    />
  );
}

function CustomersTable() {
  const q = useCustomers();
  const columns: Column<CustomerSummary>[] = [
    { key: "name", header: "Customer", sortValue: (c) => c.name, cell: (c) => <div className="grid"><span className="font-medium">{c.name}</span><span className="text-[12px] text-muted-foreground">{c.contactName} · {c.email}</span></div> },
    { key: "country", header: "Country", sortValue: (c) => c.country, cell: (c) => c.country, hideOnMobile: true },
    { key: "terms", header: "Terms", cell: (c) => <span className="tabular">{c.termsDays} days</span>, hideOnMobile: true },
    { key: "count", header: "Invoices", align: "right", sortValue: (c) => c.invoiceCount, cell: (c) => <span className="tabular">{c.invoiceCount}</span> },
    { key: "billed", header: "Total billed", align: "right", sortValue: (c) => Number(c.totalBilled.amount), cell: (c) => <Money value={c.totalBilled} /> },
    { key: "outstanding", header: "Outstanding", align: "right", sortValue: (c) => Number(c.outstanding.amount), cell: (c) => <Money value={c.outstanding} className={cn(Number(c.outstanding.amount) === 0 && "text-muted-foreground")} /> },
    { key: "last", header: "Last payment", sortValue: (c) => c.lastPaymentAt ?? "", cell: (c) => (c.lastPaymentAt ? <span className="tabular">{formatDate(c.lastPaymentAt)}</span> : <span className="text-muted-foreground">None yet</span>) },
  ];
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <DataTable
      rows={q.data}
      loading={q.isPending}
      columns={columns}
      rowKey={(c) => c.id}
      searchable
      searchText={(c) => `${c.name} ${c.contactName} ${c.email} ${c.country}`}
      searchPlaceholder="Search customers"
      initialSort={{ key: "outstanding", dir: "desc" }}
      empty={<EmptyState compact icon={<Users />} title="No customers yet" />}
    />
  );
}

function PaymentsTable() {
  const q = usePayments();
  const customers = useCustomerList();
  const invoices = useInvoices();
  const router = useRouter();
  const name = (id: string) => customers.data?.find((c) => c.id === id)?.name ?? "—";
  const number = (id: string) => invoices.data?.find((i) => i.id === id)?.number ?? "—";
  const columns: Column<Payment>[] = [
    { key: "date", header: "Date", sortValue: (p) => p.date, cell: (p) => <span className="tabular">{formatDate(p.date)}</span> },
    { key: "customer", header: "Customer", sortValue: (p) => name(p.customerId), cell: (p) => <span className="font-medium">{name(p.customerId)}</span> },
    { key: "invoice", header: "Invoice", cell: (p) => <Mono>{number(p.invoiceId)}</Mono> },
    { key: "method", header: "Method", cell: (p) => <div className="grid"><span>{PAYMENT_METHOD[p.method]}</span>{p.reference && <Mono className="text-[11.5px] text-muted-foreground">{p.reference}</Mono>}</div>, hideOnMobile: true },
    { key: "amount", header: "Amount", align: "right", sortValue: (p) => Number(p.amount.amount), cell: (p) => <Money value={p.amount} exact /> },
    { key: "ledger", header: "Ledger entry", hideOnMobile: true, cell: (p) => (p.ledgerEntryNumber ? <Mono className="text-muted-foreground">{p.ledgerEntryNumber}</Mono> : "—") },
    { key: "by", header: "Recorded by", hideOnMobile: true, cell: (p) => <EmpChip empId={p.recordedBy} size="sm" showId={false} /> },
  ];
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <DataTable
      rows={q.data}
      loading={q.isPending}
      columns={columns}
      rowKey={(p) => p.id}
      onRowClick={(p) => router.push(`/billing/invoices/${p.invoiceId}`)}
      searchable
      searchText={(p) => `${name(p.customerId)} ${number(p.invoiceId)} ${p.reference ?? ""}`}
      searchPlaceholder="Search payments"
      initialSort={{ key: "date", dir: "desc" }}
      empty={<EmptyState compact icon={<Wallet />} title="No payments recorded yet" />}
    />
  );
}
