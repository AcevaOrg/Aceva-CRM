"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, Clock, FileDown, FilePen, Plus, Undo2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { RequireAccess, Can } from "@/components/shared/can";
import { DataTable, type Column } from "@/components/shared/data-table";
import { useExport } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { StatCard } from "@/components/shared/metrics";
import { Mono } from "@/components/shared/money";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { formatDate, formatMonthKey } from "@/lib/dates";
import { formatMoneyCompact } from "@/lib/format";
import { useEntries, useFinanceProjects, usePeriods } from "../hooks";
import { monthKeyOf, SOURCE_LABEL } from "../logic";
import type { EntrySource, EntryStatus, JournalEntry } from "../types";
import { EntryAmount, EntryStatusBadge, FinanceRoleNote, SourceBadge } from "./ledger-bits";

type StatusTab = EntryStatus | "all";

export function JournalListScreen() {
  return (
    <RequireAccess permission="finance.view" mode="404">
      <JournalList />
    </RequireAccess>
  );
}

function JournalList() {
  const router = useRouter();
  const exportData = useExport();
  const [status, setStatus] = useUrlState<StatusTab>("status", "all");
  const [month, setMonth] = useUrlState<string>("month", "all");
  const [source, setSource] = useUrlState<EntrySource | "all">("source", "all");
  const all = useEntries();
  const periods = usePeriods();
  const projects = useFinanceProjects();
  const projectName = (id?: string) => projects.data?.find((p) => p.id === id)?.name;

  const entries = (all.data ?? [])
    .filter((e) => status === "all" || e.status === status)
    .filter((e) => month === "all" || monthKeyOf(e.date) === month)
    .filter((e) => source === "all" || e.source === source);

  const thisMonth = monthKeyOf(new Date());
  const list = all.data ?? [];
  const postedThisMonth = list.filter((e) => e.status === "posted" && monthKeyOf(e.date) === thisMonth);
  const count = (s: EntryStatus) => list.filter((e) => e.status === s).length;

  const columns: Column<JournalEntry>[] = [
    { key: "number", header: "Entry", cell: (e) => <Mono className="whitespace-nowrap text-[12.5px]">{e.number}</Mono>, sortValue: (e) => e.number },
    { key: "date", header: "Date", cell: (e) => <span className="whitespace-nowrap tabular">{formatDate(e.date)}</span>, sortValue: (e) => e.date },
    {
      key: "description",
      header: "Description",
      cell: (e) => (
        <span className="grid min-w-0 max-w-md leading-tight">
          <span className="truncate font-medium">{e.description}</span>
          {e.projectId && <span className="truncate text-[11.5px] text-muted-foreground">{projectName(e.projectId)}</span>}
        </span>
      ),
      sortValue: (e) => e.description,
    },
    { key: "source", header: "Source", cell: (e) => <SourceBadge source={e.source} />, hideOnMobile: true },
    { key: "total", header: "Amount", align: "right", cell: (e) => <EntryAmount entry={e} />, sortValue: (e) => Number(e.baseTotal.amount) },
    { key: "status", header: "Status", cell: (e) => <EntryStatusBadge status={e.status} rejected={e.rejected} />, sortValue: (e) => e.status },
    { key: "maker", header: "Prepared by", cell: (e) => <EmpChip empId={e.createdBy} size="sm" showId={false} link={false} />, hideOnMobile: true },
  ];

  const months = (periods.data ?? []).map((p) => p.month);

  return (
    <>
      <PageHeader
        title="Ledger"
        description="Every money entry, saved once in one double-entry ledger. Posted entries are never edited; mistakes are fixed with a reversing entry."
        seal="highly"
        actions={
          <>
            <Can permission="finance.export">
              <Button
                variant="outline"
                onClick={() => exportData({ title: "Journal entries", seal: "highly", formats: ["xlsx", "csv", "pdf"], stepUp: true, rows: entries.length })}
              >
                <FileDown /> Export
              </Button>
            </Can>
            <Can permission="finance.entry_create">
              <Button asChild>
                <Link href="/finance/ledger/new">
                  <Plus /> New entry
                </Link>
              </Button>
            </Can>
          </>
        }
      />

      <FinanceRoleNote className="mb-4" prepares="prepares and submits journal entries" />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Posted this month"
          value={postedThisMonth.length}
          hint={formatMoneyCompact(postedThisMonth.reduce((s, e) => s + Number(e.baseTotal.amount), 0))}
          icon={<BookOpen />}
          accent="var(--zone-finance)"
          onClick={() => router.replace(`/finance/ledger?status=posted&month=${thisMonth}`, { scroll: false })}
        />
        <StatCard label="Waiting for approval" value={count("pending_approval")} hint="The Director approves" icon={<Clock />} accent="var(--warning)" onClick={() => setStatus("pending_approval")} />
        <StatCard label="Drafts" value={count("draft")} hint="Not yet submitted" icon={<FilePen />} onClick={() => setStatus("draft")} />
        <StatCard label="Reversed" value={count("reversed")} hint="Kept for the record" icon={<Undo2 />} onClick={() => setStatus("reversed")} />
      </div>

      {all.isError ? (
        <ErrorState error={all.error} onRetry={() => all.refetch()} />
      ) : (
        <DataTable
          rows={entries}
          loading={all.isPending}
          columns={columns}
          rowKey={(e) => e.id}
          onRowClick={(e) => router.push(`/finance/ledger/${e.id}`)}
          searchable
          searchText={(e) => `${e.number} ${e.description} ${projectName(e.projectId) ?? ""}`}
          searchPlaceholder="Search by number or description"
          pageSize={20}
          toolbar={
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                size="sm"
                value={status}
                onChange={setStatus}
                ariaLabel="Status"
                options={[
                  { value: "all", label: "All" },
                  { value: "draft", label: "Drafts" },
                  { value: "pending_approval", label: "Pending" },
                  { value: "posted", label: "Posted" },
                  { value: "reversed", label: "Reversed" },
                ]}
              />
              <NativeSelect value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Period" className="w-44">
                <option value="all">All periods</option>
                {months.map((m) => (
                  <option key={m} value={m}>
                    {formatMonthKey(m)}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect value={source} onChange={(e) => setSource(e.target.value as EntrySource | "all")} aria-label="Source" className="w-40">
                <option value="all">All sources</option>
                {Object.entries(SOURCE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </NativeSelect>
            </div>
          }
          empty={
            <EmptyState
              icon={<BookOpen />}
              title="No entries match"
              description="Try another period, status or source."
              action={
                <Button variant="outline" onClick={() => router.replace("/finance/ledger", { scroll: false })}>
                  Clear filters
                </Button>
              }
            />
          }
        />
      )}
    </>
  );
}
