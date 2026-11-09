"use client";
import * as React from "react";
import { toast } from "sonner";
import { CircleAlert, CircleCheck, FileSpreadsheet, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable, type Column } from "@/components/shared/data-table";
import { Mono } from "@/components/shared/money";
import { cn } from "@/lib/utils";
import { useImportCommit, useImportPreview } from "../hooks";
import { goodEntries, IMPORT_COLUMNS, SAMPLE_IMPORT } from "../logic";
import type { ImportRow } from "../types";

function ymdOffset(days: number, monthOffset = 0, day?: number) {
  const d = new Date();
  if (monthOffset) d.setMonth(d.getMonth() + monthOffset, day ?? 15);
  else d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Import from CSV (plan §15): preview first, every error listed (unknown account, debits ≠ credits,
 * closed month), and only good entries are saved as drafts for approval.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const preview = useImportPreview();
  const commit = useImportCommit();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [name, setName] = React.useState<string | null>(null);
  const rows = preview.data ?? [];
  const good = goodEntries(rows);
  const goodRefs = new Set(good.map((r) => r.ref));
  const badRows = rows.filter((r) => !goodRefs.has(r.ref));

  const load = (text: string, fileName: string) => {
    setName(fileName);
    preview.mutate(text);
  };

  const columns: Column<ImportRow>[] = [
    { key: "row", header: "Row", cell: (r) => <Mono className="text-muted-foreground">{r.row}</Mono> },
    { key: "ref", header: "Entry", cell: (r) => <Mono>{r.ref}</Mono> },
    { key: "date", header: "Date", cell: (r) => r.date },
    { key: "account", header: "Account", cell: (r) => <span className="whitespace-nowrap"><Mono className="text-muted-foreground">{r.accountCode}</Mono> {r.accountName ?? ""}</span> },
    { key: "desc", header: "Description", cell: (r) => r.description, hideOnMobile: true },
    { key: "debit", header: "Debit", align: "right", cell: (r) => (r.debit ? <Mono>{r.debit.toLocaleString("en-PK")}</Mono> : "") },
    { key: "credit", header: "Credit", align: "right", cell: (r) => (r.credit ? <Mono>{r.credit.toLocaleString("en-PK")}</Mono> : "") },
    {
      key: "errors",
      header: "Check",
      cell: (r) =>
        goodRefs.has(r.ref) ? (
          <Badge tone="success"><CircleCheck /> Ready</Badge>
        ) : r.errors.length ? (
          <span className="grid gap-0.5 text-[12px] text-danger">{r.errors.map((e) => <span key={e}>{e}</span>)}</span>
        ) : (
          <span className="text-[12px] text-muted-foreground">Another line of this entry has an error</span>
        ),
    },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Import entries</DialogTitle>
          <DialogDescription>
            CSV with the columns <span className="font-mono text-[12px]">{IMPORT_COLUMNS.join(", ")}</span>. Lines with the same ref form one entry. Nothing is posted: good entries are saved as drafts and go through approval.
          </DialogDescription>
        </DialogHeader>

        {!preview.data && !preview.isPending ? (
          <div className="grid place-items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <span className="grid size-11 place-content-center rounded-2xl bg-zone-finance/12 text-zone-finance"><FileSpreadsheet className="size-5" /></span>
            <p className="text-[14px] font-medium">Choose a CSV file exported from Excel</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => fileRef.current?.click()}><Upload /> Choose file</Button>
              <Button
                variant="outline"
                onClick={() => load(SAMPLE_IMPORT.replace(/\{d1\}/g, ymdOffset(0)).replace(/\{d2\}/g, ymdOffset(0)).replace(/\{d3\}/g, ymdOffset(0, -1, 15)), "sample-import.csv")}
              >
                Try the sample file
              </Button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) load(await f.text(), f.name);
              }}
            />
          </div>
        ) : (
          <div className="grid gap-3">
            <div className={cn("flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[13px]", badRows.length ? "bg-warning/12" : "bg-success/10")}>
              {badRows.length ? <CircleAlert className="size-4 text-[oklch(0.6_0.14_70)]" /> : <CircleCheck className="size-4 text-success" />}
              <span className="font-medium">{name}</span>
              <span className="text-muted-foreground">
                {rows.length} rows · {good.length} good rows in {new Set(good.map((r) => r.ref)).size} entries · {badRows.length} rows need fixing
              </span>
            </div>
            <DataTable rows={rows} loading={preview.isPending} columns={columns} rowKey={(r) => String(r.row)} pageSize={8} dense rowClassName={(r) => (!goodRefs.has(r.ref) ? "bg-danger/5" : undefined)} />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {preview.data && (
            <Button variant="ghost" onClick={() => { preview.reset(); setName(null); }}>
              Choose another file
            </Button>
          )}
          <Button
            disabled={!good.length}
            loading={commit.isPending}
            onClick={async () => {
              try {
                const numbers = await commit.mutateAsync(rows);
                toast.success(`${numbers.length} draft entr${numbers.length === 1 ? "y" : "ies"} created`, { description: `${numbers.join(", ")}. Submit them for approval from the ledger.` });
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Couldn't import.");
              }
            }}
          >
            Save {good.length} good row{good.length === 1 ? "" : "s"} as drafts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
