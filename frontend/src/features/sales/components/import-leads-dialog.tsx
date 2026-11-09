"use client";
import * as React from "react";
import { toast } from "sonner";
import { FileUp, Upload } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/misc";
import { useImportCommit, useImportPreview } from "../hooks";
import { SAMPLE_CSV, SOURCE_LABEL } from "../logic";
import type { ImportRow } from "../types";

const STATUS: Record<ImportRow["status"], { label: string; tone: BadgeTone }> = {
  ok: { label: "Ready", tone: "success" },
  duplicate: { label: "Duplicate", tone: "warning" },
  invalid: { label: "Invalid", tone: "danger" },
  repeated: { label: "Repeated in file", tone: "neutral" },
};

/** Import from an Apollo export or any CSV: preview first, then save the good rows (plan §20). */
export function ImportLeadsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [csv, setCsv] = React.useState("");
  const [rows, setRows] = React.useState<ImportRow[] | null>(null);
  const preview = useImportPreview();
  const commit = useImportCommit();
  const fileRef = React.useRef<HTMLInputElement>(null);
  // The caller mounts this dialog only while it's open, so state starts fresh each time.

  const good = rows?.filter((r) => r.status === "ok").length ?? 0;
  const counts = rows?.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {}) ?? {};

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Import leads</DialogTitle>
          <DialogDescription>Upload the CSV exported from Apollo or paste rows. You&apos;ll see a preview first; only good rows are saved.</DialogDescription>
        </DialogHeader>
        {!rows ? (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setCsv(await f.text());
                }}
              />
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload /> Choose CSV file
              </Button>
              <Button variant="ghost" onClick={() => setCsv(SAMPLE_CSV)}>
                Use a sample file
              </Button>
              <span className="text-[12px] text-muted-foreground">Columns: name, email, company, website, country, title, source</span>
            </div>
            <Textarea value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="name,email,company,website,country,title,source" className="min-h-48 font-mono text-[12px]" aria-label="CSV rows" />
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(STATUS) as ImportRow["status"][]).map((s) =>
                counts[s] ? (
                  <Badge key={s} tone={STATUS[s].tone}>
                    {counts[s]} {STATUS[s].label.toLowerCase()}
                  </Badge>
                ) : null,
              )}
            </div>
            <div className="max-h-[50vh] overflow-auto rounded-xl border border-border scrollbar-thin">
              <Table>
                <THead>
                  <tr>
                    <TH>Line</TH>
                    <TH>Name</TH>
                    <TH>Email</TH>
                    <TH>Company</TH>
                    <TH>Source</TH>
                    <TH>Result</TH>
                  </tr>
                </THead>
                <TBody>
                  {rows.map((r) => (
                    <TR key={r.line}>
                      <TD className="font-mono text-muted-foreground">{r.line}</TD>
                      <TD className="font-medium">{r.name || "—"}</TD>
                      <TD className="font-mono text-[12px]">{r.email || "—"}</TD>
                      <TD>{r.companyName || "—"}</TD>
                      <TD>{SOURCE_LABEL[r.source]}</TD>
                      <TD>
                        <div className="grid gap-0.5">
                          <Badge tone={STATUS[r.status].tone} className="w-fit">
                            {STATUS[r.status].label}
                          </Badge>
                          {r.message && <span className="text-[11.5px] text-muted-foreground">{r.message}</span>}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </div>
        )}
        <DialogFooter>
          {rows ? (
            <>
              <Button variant="outline" onClick={() => setRows(null)}>
                Back
              </Button>
              <Button
                disabled={!good}
                loading={commit.isPending}
                onClick={() =>
                  commit.mutate(rows, {
                    onSuccess: (r) => {
                      toast.success(`${r.imported} leads imported`, { description: "You are the owner. Verify their emails before outreach." });
                      onOpenChange(false);
                    },
                  })
                }
              >
                Import {good} good {good === 1 ? "row" : "rows"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={!csv.trim()} loading={preview.isPending} onClick={() => preview.mutate(csv, { onSuccess: setRows })}>
                <FileUp /> Preview
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
