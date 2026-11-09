"use client";
import * as React from "react";
import { ArrowRight, Download, Link2, RotateCcw, ScrollText, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/misc";
import { RequireAccess } from "@/components/shared/can";
import { DataTable } from "@/components/shared/data-table";
import { useExport } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { Mono } from "@/components/shared/money";
import { EmployeeSelect } from "@/components/shared/pickers";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime, formatTime } from "@/lib/dates";
import { useAuditIntegrity, useAuditLog } from "../hooks";
import { AUDIT_ACTION_LABEL, AUDIT_MODULES } from "../logic";
import type { AuditAction, AuditFilters, AuditRecord } from "../types";

const ACTION_TONE: Partial<Record<AuditAction, BadgeTone>> = {
  approve: "success",
  post: "success",
  reject: "danger",
  reverse: "warning",
  export: "info",
  reveal: "warning",
  permission_change: "control",
  lock: "danger",
  unlock: "neutral",
  close: "finance",
  reopen: "danger",
  create: "primary",
  edit: "neutral",
  delete: "warning",
};

export function AuditScreen() {
  return (
    <RequireAccess permission="audit.view" mode="404">
      <AuditInner />
    </RequireAccess>
  );
}

function IntegrityCard() {
  const q = useAuditIntegrity();
  if (q.isPending) return <Skeleton className="h-[74px] rounded-xl" />;
  if (q.isError || !q.data) return null;
  const { ok, checkedAt, rows, brokenAt } = q.data;
  return (
    <div className={ok ? "flex items-start gap-3 rounded-xl border border-success/30 bg-success/8 p-4" : "flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 p-4"} role="status">
      <span className={ok ? "grid size-10 shrink-0 place-content-center rounded-xl bg-success/15 text-success" : "grid size-10 shrink-0 place-content-center rounded-xl bg-danger/15 text-danger"}>
        {ok ? <ShieldCheck className="size-5" /> : <ShieldAlert className="size-5" />}
      </span>
      <div className="grid gap-0.5 text-[13px]">
        <p className="font-semibold">{ok ? "Hash chain verified" : `Chain broken at row ${brokenAt}`}</p>
        <p className="text-muted-foreground">
          {ok
            ? `Every row's fingerprint matched the row before it. Checked ${formatDate(checkedAt)} at ${formatTime(checkedAt)} across ${rows} rows.`
            : "A row was changed directly in the database. The CEO / Founder / Owner, the Director and the CTO have been alerted."}
        </p>
        <p className="text-[12px] text-muted-foreground">Nobody can edit or delete this log. The app can only add rows.</p>
      </div>
    </div>
  );
}

function Changes({ r }: { r: AuditRecord }) {
  if (!r.changes?.length) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="grid gap-1">
      {r.changes.slice(0, 3).map((c) => (
        <li key={c.field} className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="font-medium">{c.field}</span>
          <span className="rounded bg-danger/10 px-1 font-mono text-[11.5px] line-through decoration-danger/50">{c.from}</span>
          <ArrowRight className="size-3 text-muted-foreground" />
          <span className="rounded bg-success/12 px-1 font-mono text-[11.5px]">{c.to}</span>
        </li>
      ))}
      {r.changes.length > 3 && <li className="text-[11.5px] text-muted-foreground">+{r.changes.length - 3} more</li>}
    </ul>
  );
}

function AuditInner() {
  const viewer = useViewer();
  const lookup = useLookup();
  const exportData = useExport();
  const [filters, setFilters] = React.useState<AuditFilters>({ empId: "", module: "", action: "", from: "", to: "", q: "" });
  const [q, setQ] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setFilters((f) => ({ ...f, q })), 250);
    return () => clearTimeout(t);
  }, [q]);
  const log = useAuditLog(filters);
  const set = (k: keyof AuditFilters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const active = Object.entries(filters).some(([, v]) => !!v);
  // Exports are for the CEO / Founder / Owner and the Director: the two people who hold audit.view and the export permissions.
  const canExport = !!viewer?.can("audit.view") && !!viewer.can(["statements.export", "finance.export"]);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="The permanent record of every change, approval and export: who, what, old value, new value, when."
        seal="highly"
        actions={
          canExport && (
            <Button variant="outline" onClick={() => exportData({ title: "audit log", seal: "highly", stepUp: true, formats: ["xlsx", "csv", "pdf"], rows: log.data?.length })}>
              <Download /> Export
            </Button>
          )
        }
      />
      <div className="grid gap-5">
        <IntegrityCard />

        <div className="grid gap-2 rounded-xl border border-border bg-card p-3 shadow-strata sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))_auto_auto_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search record or description" className="pl-8" aria-label="Search the audit log" />
          </div>
          <EmployeeSelect value={filters.empId ?? ""} onChange={set("empId")} placeholder="Anyone" />
          <NativeSelect value={filters.module} onChange={(e) => set("module")(e.target.value)} aria-label="Module">
            <option value="">All modules</option>
            {AUDIT_MODULES.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </NativeSelect>
          <NativeSelect value={filters.action} onChange={(e) => set("action")(e.target.value)} aria-label="Action">
            <option value="">All actions</option>
            {(Object.keys(AUDIT_ACTION_LABEL) as AuditAction[]).map((a) => (
              <option key={a} value={a}>
                {AUDIT_ACTION_LABEL[a]}
              </option>
            ))}
          </NativeSelect>
          <Input type="date" value={filters.from} onChange={(e) => set("from")(e.target.value)} aria-label="From date" className="lg:w-36" />
          <Input type="date" value={filters.to} onChange={(e) => set("to")(e.target.value)} aria-label="To date" className="lg:w-36" />
          <Button
            variant="ghost"
            disabled={!active}
            onClick={() => {
              setQ("");
              setFilters({ empId: "", module: "", action: "", from: "", to: "", q: "" });
            }}
          >
            <RotateCcw /> Clear
          </Button>
        </div>

        {log.isError ? (
          <ErrorState error={log.error} onRetry={() => log.refetch()} />
        ) : (
          <DataTable<AuditRecord>
            rows={log.data}
            loading={log.isPending}
            rowKey={(r) => r.id}
            pageSize={20}
            empty={<EmptyState icon={<ScrollText />} title="No matching records" description={active ? "Try fewer filters." : "Changes appear here as people use the system."} />}
            columns={[
              {
                key: "at",
                header: "When",
                cell: (r) => (
                  <span className="grid leading-tight">
                    <span className="whitespace-nowrap">{formatDate(r.at)}</span>
                    <span className="font-mono text-[11.5px] text-muted-foreground">{formatTime(r.at)}</span>
                  </span>
                ),
                sortValue: (r) => r.seq,
                width: "112px",
              },
              { key: "who", header: "Who", cell: (r) => <EmpChip empId={r.empId} size="sm" />, sortValue: (r) => lookup.employee(r.empId)?.name ?? r.empId },
              {
                key: "what",
                header: "What",
                cell: (r) => (
                  <div className="grid max-w-md gap-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={ACTION_TONE[r.action] ?? "neutral"}>{AUDIT_ACTION_LABEL[r.action]}</Badge>
                      <span className="text-[11.5px] text-muted-foreground">{r.module}</span>
                    </span>
                    <span>{r.summary}</span>
                    {r.reason && <span className="text-[12px] text-muted-foreground">Reason: “{r.reason}”</span>}
                  </div>
                ),
              },
              { key: "record", header: "Record", cell: (r) => <Mono className="text-[12px]">{r.recordId}</Mono>, hideOnMobile: true },
              { key: "changes", header: "Old → new", cell: (r) => <Changes r={r} />, hideOnMobile: true },
              {
                key: "hash",
                header: "Fingerprint",
                hideOnMobile: true,
                cell: (r) => (
                  <Tip
                    content={
                      <span className="grid gap-0.5 font-mono text-[11px]">
                        <span>Row {r.seq}</span>
                        <span>This: {r.hash}</span>
                        <span>Previous: {r.prevHash}</span>
                        <span className="font-sans">Logged {formatDateTime(r.at)} from {r.ip}</span>
                      </span>
                    }
                  >
                    <span tabIndex={0} className="inline-flex items-center gap-1 font-mono text-[11.5px] text-muted-foreground outline-none">
                      <Link2 className="size-3" />
                      {r.hash.slice(0, 8)}
                    </span>
                  </Tip>
                ),
              },
            ]}
          />
        )}
      </div>
    </>
  );
}
