"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AgGridReact } from "ag-grid-react";
import type { CellEditRequestEvent, ColDef, GridApi, GridReadyEvent, ICellRendererParams } from "ag-grid-community";
import { toast } from "sonner";
import { Bookmark, FileDown, Lock, Pencil, Save, Search, Trash2, Upload } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/overlays";
import { Can, RequireAccess } from "@/components/shared/can";
import { useExport } from "@/components/shared/dialogs";
import { ErrorState, ListSkeleton } from "@/components/shared/states";
import { useCorrection } from "@/features/ledger/hooks";
import { GROUP_LABEL, GROUP_ORDER, STATUS_LABEL } from "@/features/ledger/logic";
import type { AccountGroup, EntryStatus } from "@/features/ledger/types";
import { useCan } from "@/lib/auth/viewer";
import { formatDate, formatMonthKey } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useDeleteView, useSavedViews, useSaveView, useSheetRows, useUpdateDraftLine } from "../hooks";
import { aggregate, type AggFn } from "../logic";
import type { LedgerRow, SavedView, SheetFilters } from "../types";
import { strataGridTheme } from "./grid-theme";
import { ImportDialog } from "./import-dialog";

const DEFAULT_FILTERS: SheetFilters = { status: "in_books", month: "all", group: "all", currency: "all" };

const STATUS_CLASS: Record<EntryStatus, string> = {
  draft: "bg-muted text-foreground",
  pending_approval: "bg-warning/18 text-foreground",
  posted: "bg-success/14 text-foreground",
  reversed: "bg-muted text-muted-foreground line-through",
};

const DEFAULT_COL_DEF: ColDef<LedgerRow> = { sortable: true, filter: true, resizable: true, minWidth: 80 };
const getRowId = (p: { data: LedgerRow }) => p.data.id;

const money = (v: unknown) => (typeof v === "number" && v ? v.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "");

export function SheetScreen() {
  return (
    <RequireAccess permission="sheet.view" mode="404">
      <LedgerSheet />
    </RequireAccess>
  );
}

interface PendingEdit {
  row: LedgerRow;
  field: "description" | "debit" | "credit";
  value: string;
}

function LedgerSheet() {
  const router = useRouter();
  const exportData = useExport();
  const rowsQ = useSheetRows();
  const viewsQ = useSavedViews();
  const saveView = useSaveView();
  const deleteView = useDeleteView();
  const updateDraft = useUpdateDraftLine();
  const correction = useCorrection();
  // Only the finance person edits (drafts, or correcting drafts for posted rows). Everyone else views.
  const canEdit = useCan("finance.entry_create");
  const apiRef = React.useRef<GridApi<LedgerRow> | null>(null);
  const [filters, setFilters] = React.useState<SheetFilters>(DEFAULT_FILTERS);
  const [quick, setQuick] = React.useState("");
  const [viewId, setViewId] = React.useState("v-all");
  const [shown, setShown] = React.useState<LedgerRow[]>([]);
  const [aggCol, setAggCol] = React.useState<"debit" | "credit" | "lines">("debit");
  const [aggFn, setAggFn] = React.useState<AggFn>("sum");
  const [edit, setEdit] = React.useState<PendingEdit | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [naming, setNaming] = React.useState(false);

  const all = React.useMemo(() => rowsQ.data ?? [], [rowsQ.data]);
  const months = [...new Set(all.map((r) => r.month))].sort().reverse();
  const rows = React.useMemo(
    () =>
      all.filter(
        (r) =>
          (filters.status === "all" || (filters.status === "in_books" ? r.locked : r.status === filters.status)) &&
          (filters.month === "all" || r.month === filters.month) &&
          (filters.group === "all" || r.group === filters.group) &&
          (filters.currency === "all" || r.currency === filters.currency),
      ),
    [all, filters],
  );

  const columns = React.useMemo<ColDef<LedgerRow>[]>(
    () => [
      {
        colId: "lock",
        headerName: "",
        width: 46,
        pinned: "left",
        sortable: false,
        filter: false,
        resizable: false,
        suppressMovable: true,
        cellRenderer: (p: ICellRendererParams<LedgerRow>) =>
          p.data?.locked ? (
            <span title="Posted: read-only. Editing creates a correcting draft." className="grid h-full place-content-center text-muted-foreground">
              <Lock className="size-3.5" />
            </span>
          ) : p.data?.status === "draft" ? (
            <span title="Draft: can be edited" className="grid h-full place-content-center text-primary">
              <Pencil className="size-3.5" />
            </span>
          ) : null,
      },
      { field: "date", headerName: "Date", width: 118, pinned: "left", valueFormatter: (p) => (p.value ? formatDate(p.value) : ""), filterValueGetter: (p) => (p.data ? formatDate(p.data.date) : "") },
      {
        field: "entryNumber",
        headerName: "Entry",
        width: 132,
        pinned: "left",
        cellClass: "font-mono text-[12.5px] text-primary cursor-pointer",
        onCellClicked: (p) => {
          if (p.data) router.push(`/finance/ledger/${p.data.entryId}`);
        },
      },
      { field: "account", headerName: "Account", width: 250 },
      { field: "description", headerName: "Description", width: 260, editable: (p) => canEdit && p.data?.status !== "pending_approval" },
      { field: "client", headerName: "Client or vendor", width: 170 },
      { field: "project", headerName: "Project", width: 190 },
      { field: "employee", headerName: "Employee", width: 140 },
      { field: "debit", headerName: "Debit (PKR)", width: 150, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => money(p.value), cellClass: "font-mono", editable: (p) => canEdit && p.data?.status !== "pending_approval" },
      { field: "credit", headerName: "Credit (PKR)", width: 150, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => money(p.value), cellClass: "font-mono", editable: (p) => canEdit && p.data?.status !== "pending_approval" },
      { field: "currency", headerName: "Currency", width: 104 },
      {
        field: "status",
        headerName: "Status",
        width: 150,
        filterValueGetter: (p) => (p.data ? STATUS_LABEL[p.data.status] : ""),
        cellRenderer: (p: ICellRendererParams<LedgerRow>) =>
          p.data ? <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-medium", STATUS_CLASS[p.data.status])}>{STATUS_LABEL[p.data.status]}</span> : null,
      },
    ],
    [router, canEdit],
  );

  const recompute = React.useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const out: LedgerRow[] = [];
    api.forEachNodeAfterFilterAndSort((n) => {
      if (n.data) out.push(n.data);
    });
    // Only update when the visible rows actually changed (avoids a render loop with the grid).
    setShown((prev) => (prev.length === out.length && prev.every((r, i) => r === out[i]) ? prev : out));
  }, []);

  const applyView = (v: SavedView) => {
    setViewId(v.id);
    setFilters(v.filters);
    const api = apiRef.current;
    if (!api) return;
    api.setFilterModel((v.filterModel as Parameters<GridApi["setFilterModel"]>[0]) ?? null);
    api.applyColumnState({ state: (v.sort ?? []).map((s) => ({ colId: s.colId, sort: s.sort })), defaultState: { sort: null } });
  };

  const onEdit = (e: CellEditRequestEvent<LedgerRow>) => {
    const field = e.colDef.field as PendingEdit["field"];
    const row = e.data;
    if (!row || e.newValue === e.oldValue) return;
    const value = String(e.newValue ?? "");
    if (field !== "description" && Number.isNaN(Number(value))) {
      toast.error("Enter a number.");
      return;
    }
    if (row.locked) {
      setEdit({ row, field, value });
      return;
    }
    updateDraft.mutate(
      { entryId: row.entryId, lineId: row.lineId, field, value },
      { onSuccess: () => toast.success(`${row.entryNumber} updated`, { description: field === "description" ? undefined : "The draft must balance again before it can be submitted." }) },
    );
  };

  const setFilter = (patch: Partial<SheetFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setViewId("custom");
  };

  const views = viewsQ.data ?? [];
  const current = views.find((v) => v.id === viewId);
  const values = aggCol === "lines" ? [] : shown.map((r) => r[aggCol]).filter((v) => v !== 0);
  const aggResult = aggCol === "lines" ? shown.length : aggregate(values, aggFn);
  const totalDr = shown.reduce((s, r) => s + r.debit, 0);
  const totalCr = shown.reduce((s, r) => s + r.credit, 0);

  return (
    <>
      <PageHeader
        title="Spreadsheet"
        description="The ledger as rows and columns. Posted rows are read-only; editing one creates a correcting draft that goes through normal approval."
        seal="highly"
        actions={
          <>
            <Can permission="sheet.import">
              <Button variant="outline" onClick={() => setImporting(true)}>
                <Upload /> Import
              </Button>
            </Can>
            <Can permission="finance.export">
              <Button
                variant="outline"
                onClick={async () => {
                  const f = await exportData({ title: "Ledger spreadsheet", seal: "highly", formats: ["csv", "xlsx"], stepUp: true, rows: shown.length });
                  if (f === "csv") apiRef.current?.exportDataAsCsv({ fileName: `aceva-ledger-${new Date().toISOString().slice(0, 10)}.csv`, columnKeys: columns.filter((c) => c.field).map((c) => c.field as string) });
                }}
              >
                <FileDown /> Export
              </Button>
            </Can>
          </>
        }
      />

      <Card className="mb-3 flex flex-wrap items-end gap-3 p-3">
        <Field label="Saved view" className="w-64">
          <NativeSelect
            value={viewId}
            onChange={(e) => {
              const v = views.find((x) => x.id === e.target.value);
              if (v) applyView(v);
            }}
          >
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.builtIn ? "" : " (mine)"}
              </option>
            ))}
            {!views.some((v) => v.id === viewId) && <option value={viewId}>Unsaved view</option>}
          </NativeSelect>
        </Field>
        <Field label="Status" className="w-40">
          <NativeSelect value={filters.status} onChange={(e) => setFilter({ status: e.target.value as SheetFilters["status"] })}>
            <option value="in_books">In the books</option>
            <option value="all">All statuses</option>
            <option value="posted">Posted</option>
            <option value="pending_approval">Pending approval</option>
            <option value="draft">Draft</option>
            <option value="reversed">Reversed</option>
          </NativeSelect>
        </Field>
        <Field label="Month" className="w-44">
          <NativeSelect value={filters.month} onChange={(e) => setFilter({ month: e.target.value })}>
            <option value="all">All months</option>
            {months.map((m) => (
              <option key={m} value={m}>
                {formatMonthKey(m)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Account group" className="w-40">
          <NativeSelect value={filters.group} onChange={(e) => setFilter({ group: e.target.value as AccountGroup | "all" })}>
            <option value="all">All groups</option>
            {GROUP_ORDER.map((g) => (
              <option key={g} value={g}>
                {GROUP_LABEL[g]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Currency" className="w-32">
          <NativeSelect value={filters.currency} onChange={(e) => setFilter({ currency: e.target.value as SheetFilters["currency"] })}>
            <option value="all">All</option>
            <option value="PKR">PKR</option>
            <option value="USD">USD</option>
          </NativeSelect>
        </Field>
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Search every column" className="pl-8" aria-label="Search every column" />
        </div>
        <div className="flex gap-1">
          <Tip content="Save the current filters, column filters and sort as a view">
            <Button variant="outline" size="icon" onClick={() => setNaming(true)} aria-label="Save view">
              <Save />
            </Button>
          </Tip>
          {current && !current.builtIn && (
            <Tip content="Delete this view">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete view"
                onClick={async () => {
                  await deleteView.mutateAsync(current.id);
                  if (views[0]) applyView(views[0]);
                  toast("View deleted");
                }}
              >
                <Trash2 />
              </Button>
            </Tip>
          )}
        </div>
      </Card>

      {rowsQ.isPending ? (
        <ListSkeleton rows={12} />
      ) : rowsQ.isError ? (
        <ErrorState error={rowsQ.error} onRetry={() => rowsQ.refetch()} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border shadow-strata">
          <div style={{ height: "calc(100dvh - 400px)", minHeight: 380 }}>
            <AgGridReact<LedgerRow>
              theme={strataGridTheme}
              rowData={rows}
              columnDefs={columns}
              defaultColDef={DEFAULT_COL_DEF}
              getRowId={getRowId}
              quickFilterText={quick}
              readOnlyEdit
              stopEditingWhenCellsLoseFocus
              onCellEditRequest={onEdit}
              onGridReady={(e: GridReadyEvent<LedgerRow>) => {
                apiRef.current = e.api;
                recompute();
              }}
              onModelUpdated={recompute}
              overlayNoRowsTemplate="No lines match these filters."
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border bg-muted/60 px-4 py-2.5 text-[12.5px]">
            <span className="text-muted-foreground">
              <span className="font-semibold text-foreground tabular">{shown.length}</span> lines
            </span>
            <span className="text-muted-foreground">
              Debit Σ <span className="font-mono font-semibold text-foreground tabular">{formatMoney(totalDr, { exact: true })}</span>
            </span>
            <span className="text-muted-foreground">
              Credit Σ <span className="font-mono font-semibold text-foreground tabular">{formatMoney(totalCr, { exact: true })}</span>
            </span>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <NativeSelect value={aggFn} onChange={(e) => setAggFn(e.target.value as AggFn)} aria-label="Formula" className="w-32" disabled={aggCol === "lines"}>
                <option value="sum">Sum</option>
                <option value="avg">Average</option>
                <option value="count">Count</option>
                <option value="min">Minimum</option>
                <option value="max">Maximum</option>
              </NativeSelect>
              <span className="text-muted-foreground">of</span>
              <NativeSelect value={aggCol} onChange={(e) => setAggCol(e.target.value as typeof aggCol)} aria-label="Column" className="w-36">
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
                <option value="lines">Lines</option>
              </NativeSelect>
              <span className="font-mono font-semibold tabular">= {aggCol === "lines" || aggFn === "count" ? aggResult.toLocaleString("en-PK") : formatMoney(aggResult, { exact: true })}</span>
            </span>
          </div>
        </div>
      )}
      <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Bookmark className="size-3.5" />{" "}
        {canEdit ? "Double-click a cell to edit. Every edit, import and export is logged." : "View only. The finance person edits and imports entries; the Director approves them."}
      </p>

      {edit && (
        <CorrectionDialog
          edit={edit}
          busy={correction.isPending}
          onClose={() => setEdit(null)}
          onConfirm={async () => {
            const value = edit.field === "description" ? edit.value : String(Number(edit.value) / (edit.row.exchangeRate || 1));
            try {
              const r = await correction.mutateAsync({ entryId: edit.row.entryId, lineId: edit.row.lineId, field: edit.field, value });
              toast.success("Correcting drafts created", {
                description: (
                  <span>
                    <Link className="underline" href={`/finance/ledger/${r.reversal.id}`}>
                      {r.reversal.number}
                    </Link>{" "}
                    reverses the original and{" "}
                    <Link className="underline" href={`/finance/ledger/${r.corrected.id}`}>
                      {r.corrected.number}
                    </Link>{" "}
                    holds the corrected line. Submit both for approval.
                  </span>
                ),
              });
              setEdit(null);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Couldn't create the correction.");
            }
          }}
        />
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {naming && (
        <SaveViewDialog
          onClose={() => setNaming(false)}
          busy={saveView.isPending}
          onSave={async (name) => {
            const api = apiRef.current;
            const v = await saveView.mutateAsync({
              name,
              filters,
              filterModel: api?.getFilterModel() ?? null,
              sort: (api?.getColumnState() ?? []).filter((c) => c.sort).map((c) => ({ colId: c.colId, sort: c.sort as "asc" | "desc" })),
            });
            setViewId(v.id);
            setNaming(false);
            toast.success(`View “${name}” saved`);
          }}
        />
      )}
    </>
  );
}

function CorrectionDialog({ edit, busy, onClose, onConfirm }: { edit: PendingEdit; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const from = edit.field === "description" ? edit.row.description : formatMoney(edit.row[edit.field], { exact: true });
  const to = edit.field === "description" ? edit.value : formatMoney(Number(edit.value), { exact: true });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <span className="mb-1 grid size-10 place-content-center rounded-xl bg-warning/15 text-[oklch(0.6_0.14_70)]">
            <Lock className="size-5" />
          </span>
          <DialogTitle>{edit.row.entryNumber} is posted</DialogTitle>
          <DialogDescription>Posted entries are never changed. Create a correcting draft instead? Two drafts are made, and both go through normal approval:</DialogDescription>
        </DialogHeader>
        <ol className="grid gap-2 text-[13px]">
          <li className="rounded-lg border border-border px-3 py-2">
            <span className="font-medium">1. A reversing entry</span> that cancels {edit.row.entryNumber}.
          </li>
          <li className="rounded-lg border border-border px-3 py-2">
            <span className="font-medium">2. A corrected copy</span> with the {edit.field} changed from <span className="font-mono">{from}</span> to <span className="font-mono">{to}</span>
            {edit.field !== "description" ? " (the other side is adjusted so it balances)." : "."}
          </li>
        </ol>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onConfirm} loading={busy}>
            Create correcting drafts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SaveViewDialog({ onClose, onSave, busy }: { onClose: () => void; onSave: (name: string) => void; busy: boolean }) {
  const [name, setName] = React.useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Save this view</DialogTitle>
          <DialogDescription>Keeps the filters, column filters and sort, for example “November expenses by project”.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim().length >= 3) onSave(name.trim());
          }}
        >
          <Field label="Name" htmlFor="view-name">
            <Input id="view-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={name.trim().length < 3} loading={busy}>
              Save view
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
