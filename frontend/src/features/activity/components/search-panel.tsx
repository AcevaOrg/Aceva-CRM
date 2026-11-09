"use client";
import * as React from "react";
import { Download, SearchX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useExport } from "@/components/shared/dialogs";
import { DataTable } from "@/components/shared/data-table";
import { EmpChip } from "@/components/shared/emp-chip";
import { EmployeeSelect } from "@/components/shared/pickers";
import { EmptyState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { descendantsOf } from "@/lib/auth/scope";
import { useViewer } from "@/lib/auth/viewer";
import { formatDateTime, isoDay } from "@/lib/dates";
import { useActivityEvents, useLogExport } from "../hooks";
import type { ActivityAction, ActivityEvent, ActivityQuery, ActivitySource } from "../types";
import { ACTION_META, ActionBadge, SOURCES, SourceChip } from "./activity-bits";

const MODULES = ["Login", "Tasks", "Ledger", "Banking", "Payroll", "Statements", "People", "Leave", "Sales", "Approvals", "Activity", "Announcements"];

/** Activity search with export (plan §8). The export itself is logged. */
export function SearchPanel() {
  const lookup = useLookup();
  const viewer = useViewer();
  // Only people the viewer may see: themselves and everyone below them in their reporting line.
  const inScope = new Set(viewer ? [viewer.employee.empId, ...descendantsOf(viewer.employee.empId, lookup.employees)] : []);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const [q, setQ] = React.useState<ActivityQuery>({ from: isoDay(weekAgo), to: isoDay(new Date()) });
  const query = useActivityEvents(q);
  const exportData = useExport();
  const logExport = useLogExport();
  const set = (patch: Partial<ActivityQuery>) => setQ((x) => ({ ...x, ...patch }));
  const rows = query.data ?? [];

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 rounded-xl border border-border bg-card p-4 shadow-strata sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Person" htmlFor="s-emp">
          <EmployeeSelect id="s-emp" value={q.empId ?? ""} onChange={(v) => set({ empId: v || undefined })} filter={(e) => inScope.has(e.empId)} placeholder="Anyone in your reporting line" />
        </Field>
        <Field label="Department" htmlFor="s-dep">
          <NativeSelect id="s-dep" value={q.departmentId ?? ""} onChange={(e) => set({ departmentId: e.target.value || undefined })}>
            <option value="">Any department</option>
            {lookup.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Module" htmlFor="s-mod">
          <NativeSelect id="s-mod" value={q.module ?? ""} onChange={(e) => set({ module: e.target.value || undefined })}>
            <option value="">Any module</option>
            {MODULES.map((m) => <option key={m}>{m}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Action" htmlFor="s-act">
          <NativeSelect id="s-act" value={q.action ?? ""} onChange={(e) => set({ action: e.target.value as ActivityAction | "" })}>
            <option value="">Any action</option>
            {(Object.keys(ACTION_META) as ActivityAction[]).map((a) => <option key={a} value={a}>{ACTION_META[a].label}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Source" htmlFor="s-src">
          <NativeSelect id="s-src" value={q.source ?? ""} onChange={(e) => set({ source: e.target.value as ActivitySource | "" })}>
            <option value="">Any source</option>
            {(Object.keys(SOURCES) as ActivitySource[]).map((s) => <option key={s} value={s}>{SOURCES[s]}</option>)}
          </NativeSelect>
        </Field>
        <Field label="From" htmlFor="s-from">
          <Input id="s-from" type="date" value={q.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} />
        </Field>
        <Field label="To" htmlFor="s-to">
          <Input id="s-to" type="date" value={q.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} />
        </Field>
        <div className="flex items-end gap-2">
          <Button variant="ghost" onClick={() => setQ({ from: isoDay(weekAgo), to: isoDay(new Date()) })}>
            <X /> Reset
          </Button>
          <Button
            variant="outline"
            disabled={!rows.length}
            onClick={async () => {
              const format = await exportData({ title: "Activity search results", seal: "confidential", formats: ["xlsx", "pdf"], rows: rows.length });
              if (format) logExport.mutate({ rows: rows.length, format });
            }}
          >
            <Download /> Export
          </Button>
        </div>
      </div>

      <DataTable<ActivityEvent>
        rows={rows}
        loading={query.isPending}
        rowKey={(e) => e.id}
        pageSize={20}
        initialSort={{ key: "at", dir: "desc" }}
        searchable
        searchText={(e) => `${e.description} ${e.target ?? ""} ${lookup.employee(e.empId)?.name ?? ""}`}
        searchPlaceholder="Search in the results"
        empty={<EmptyState icon={<SearchX />} title="No activity matches" description="Widen the dates or clear a filter." />}
        columns={[
          { key: "at", header: "When", cell: (e) => <span className="whitespace-nowrap tabular">{formatDateTime(e.at)}</span>, sortValue: (e) => e.at },
          { key: "who", header: "Who", cell: (e) => <EmpChip empId={e.empId} size="sm" />, sortValue: (e) => e.empId },
          { key: "action", header: "Action", cell: (e) => <ActionBadge action={e.action} />, sortValue: (e) => e.action },
          { key: "module", header: "Module", cell: (e) => e.module, sortValue: (e) => e.module, hideOnMobile: true },
          {
            key: "what",
            header: "What",
            cell: (e) => (
              <span className="grid gap-1">
                <span>{e.description}</span>
                {e.changes?.map((c) => (
                  <span key={c.field} className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {c.field}: <span className="text-muted-foreground line-through">{c.from}</span> → {c.to}
                  </span>
                ))}
              </span>
            ),
          },
          { key: "source", header: "Source", cell: (e) => <SourceChip source={e.source} />, hideOnMobile: true },
          { key: "where", header: "Where", cell: (e) => <span className="text-[12px] text-muted-foreground">{[e.city, e.device].filter(Boolean).join(" · ") || "—"}</span>, hideOnMobile: true },
        ]}
      />
    </div>
  );
}
