"use client";
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { BadgeCheck, FileDown, FileText, Lock, Printer, Table2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect, SegmentedControl, Switch } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tip } from "@/components/ui/overlays";
import { RequireAccess } from "@/components/shared/can";
import { useExport } from "@/components/shared/dialogs";
import { ErrorState, ListSkeleton } from "@/components/shared/states";
import { AccountPicker } from "@/features/ledger/components/account-picker";
import { useLookup } from "@/hooks/use-directory";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { Currency } from "@/types";
import { useMarkFinal, useStatement, useStatementAccounts } from "../hooks";
import { fyStart, ymd } from "../logic";
import { REPORT_ORDER, STATEMENT_META, STATEMENT_ORDER, type StatementParams, type StatementType } from "../types";
import { SelfCheck } from "./self-check";
import { StatementPaper } from "./statement-paper";

function presets(): { key: string; label: string; from: string; to: string }[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const fy = new Date(fyStart(now.getTime()));
  const q = Math.floor(m / 3) * 3;
  return [
    { key: "fytd", label: "Finance year to date", from: ymd(fy), to: ymd(now) },
    { key: "month", label: "This month", from: ymd(new Date(y, m, 1)), to: ymd(now) },
    { key: "last-month", label: "Last month", from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) },
    { key: "quarter", label: "This quarter", from: ymd(new Date(y, q, 1)), to: ymd(now) },
    { key: "last-fy", label: "Last finance year", from: ymd(new Date(fy.getFullYear() - 1, 6, 1)), to: ymd(new Date(fy.getFullYear(), 5, 30)) },
  ];
}

export function StatementsScreen() {
  return (
    <RequireAccess permission="statements.view" mode="404">
      <Statements />
    </RequireAccess>
  );
}

function Statements() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const viewer = useViewer();
  const lookup = useLookup();
  const exportData = useExport();
  const markFinal = useMarkFinal();
  const accounts = useStatementAccounts();
  const P = React.useMemo(() => presets(), []);

  const p: StatementParams = {
    type: (params.get("type") as StatementType) || "balance-sheet",
    from: params.get("from") || P[0].from,
    to: params.get("to") || P[0].to,
    currency: (params.get("currency") as Currency) || "PKR",
    compare: params.get("compare") === "1",
    accountId: params.get("account") || undefined,
  };
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    Object.entries(patch).forEach(([k, v]) => (v === null ? next.delete(k) : next.set(k, v)));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const q = useStatement(p);
  const meta = STATEMENT_META[p.type];
  const preset = P.find((x) => x.from === p.from && x.to === p.to)?.key ?? "custom";
  const asAt = p.type === "balance-sheet" || p.type === "trial-balance" || p.type === "ar-aging" || p.type === "ap-due";
  const s = q.data;
  const checksOk = !!s && s.checks.every((c) => c.pass);
  const canFinal = !!viewer && (viewer.can("finance.entry_approve") || viewer.can("finance.close"));

  const navItem = (t: StatementType) => (
    <li key={t}>
      <button
        type="button"
        onClick={() => set({ type: t, account: t === "general-ledger" ? (p.accountId ?? "acc-1110") : null })}
        aria-current={p.type === t ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition hover:bg-muted",
          p.type === t && "bg-zone-finance/10 font-semibold text-foreground",
        )}
      >
        {STATEMENT_META[t].isStatement ? <FileText className="size-4 shrink-0 text-zone-finance" /> : <Table2 className="size-4 shrink-0 text-muted-foreground" />}
        <span className="truncate">{STATEMENT_META[t].short}</span>
      </button>
    </li>
  );

  return (
    <>
      <PageHeader
        title="Financial statements"
        description="Built from posted entries for any date range. Each one checks itself before it can be marked final."
        seal="highly"
        actions={
          <>
            <Button variant="outline" onClick={() => window.print()}>
              <Printer /> Print
            </Button>
            {viewer?.can("statements.export") && (
              <Button variant="outline" disabled={!s} onClick={() => s && exportData({ title: s.title, seal: "highly", formats: ["pdf", "xlsx"], stepUp: true })}>
                <FileDown /> Export
              </Button>
            )}
            {meta.isStatement && canFinal && (
              <Tip content={!checksOk ? "A built-in check failed" : s?.status !== "draft" ? "Already final" : undefined}>
                <span>
                  <Button
                    disabled={!s || !checksOk || s.status !== "draft"}
                    loading={markFinal.isPending}
                    onClick={async () => {
                      try {
                        await markFinal.mutateAsync(p);
                        toast.success(`${meta.title} marked final`, { description: "Logged in the audit trail." });
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Couldn't mark final.");
                      }
                    }}
                  >
                    <BadgeCheck /> Mark final
                  </Button>
                </span>
              </Tip>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Statements and reports" className="print:hidden">
          <Card className="p-2 lg:sticky lg:top-20">
            <p className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Statements</p>
            <ul className="grid gap-0.5">{STATEMENT_ORDER.map(navItem)}</ul>
            <p className="px-2.5 pb-1 pt-4 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Reports</p>
            <ul className="grid gap-0.5">{REPORT_ORDER.map(navItem)}</ul>
          </Card>
        </nav>

        <div className="grid min-w-0 content-start gap-4">
          <Card className="flex flex-wrap items-end gap-3 p-4 print:hidden">
            <Field label="Period" className="w-52">
              <NativeSelect
                value={preset}
                onChange={(e) => {
                  const x = P.find((y) => y.key === e.target.value);
                  if (x) set({ from: x.from, to: x.to });
                }}
              >
                {P.map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.label}
                  </option>
                ))}
                <option value="custom" disabled>
                  Custom range
                </option>
              </NativeSelect>
            </Field>
            {!asAt && (
              <Field label="From" htmlFor="st-from" className="w-40">
                <Input id="st-from" type="date" value={p.from} max={p.to} onChange={(e) => e.target.value && set({ from: e.target.value })} />
              </Field>
            )}
            <Field label={asAt ? "As at" : "To"} htmlFor="st-to" className="w-40">
              <Input id="st-to" type="date" value={p.to} min={asAt ? undefined : p.from} onChange={(e) => e.target.value && set({ to: e.target.value })} />
            </Field>
            {p.type === "general-ledger" && (
              <Field label="Account" className="w-72">
                <AccountPicker accounts={accounts.data ?? []} value={p.accountId ?? "acc-1110"} onChange={(id) => set({ account: id })} />
              </Field>
            )}
            <Field label="Currency">
              <SegmentedControl value={p.currency} onChange={(c) => set({ currency: c })} options={[{ value: "PKR", label: "PKR" }, { value: "USD", label: "USD" }]} />
            </Field>
            {meta.isStatement && (
              <div className="flex h-9 items-center gap-2">
                <Switch id="st-compare" checked={p.compare} onCheckedChange={(v) => set({ compare: v ? "1" : null })} />
                <Label htmlFor="st-compare">Compare with previous period</Label>
              </div>
            )}
          </Card>

          {q.isPending ? (
            <ListSkeleton rows={10} />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : (
            s && (
              <>
                <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground print:hidden">
                  {meta.isStatement &&
                    (s.status === "snapshot" ? (
                      <Badge tone="info">
                        <Lock /> Closed-month snapshot{s.snapshotAt ? ` · ${formatDate(s.snapshotAt)}` : ""}
                      </Badge>
                    ) : s.status === "final" ? (
                      <Badge tone="success">
                        <BadgeCheck /> Final{s.finalBy ? ` · ${lookup.employee(s.finalBy)?.name ?? s.finalBy}` : ""}
                      </Badge>
                    ) : (
                      <Badge tone="neutral" dot>
                        Draft
                      </Badge>
                    ))}
                  <span>{meta.description}.</span>
                  <span className={cn(q.isFetching && "animate-pulse")}>Generated {formatDateTime(s.generatedAt)}</span>
                  {s.compare && <span>· Compared with {formatDate(`${s.compare.from}T12:00:00`)} – {formatDate(`${s.compare.to}T12:00:00`)}</span>}
                </div>
                <SelfCheck checks={s.checks} currency={s.currency} />
                <StatementPaper statement={s} onAccount={(id) => set({ type: "general-ledger", account: id })} />
              </>
            )
          )}
        </div>
      </div>
    </>
  );
}
