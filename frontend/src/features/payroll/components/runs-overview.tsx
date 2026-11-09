"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, Banknote, CalendarRange, HandCoins, Play, Receipt, Users } from "lucide-react";
import { PageHeader, SectionTitle } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tip } from "@/components/ui/overlays";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/misc";
import { ApprovalRelay } from "@/components/shared/approval-relay";
import { EChart, type EChartOption } from "@/components/shared/echart";
import { StatCard } from "@/components/shared/metrics";
import { Money } from "@/components/shared/money";
import { CardsSkeleton, EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useCan } from "@/lib/auth/viewer";
import { formatDate, formatMonthKey, formatMonthShort, monthKey } from "@/lib/dates";
import { formatMoneyCompact, toNumber } from "@/lib/format";
import { usePayrollRuns, useStartRun, useTaxSlabs } from "../hooks";
import { nextMonthKey } from "../logic";
import type { PayrollRun } from "../types";
import { StageBadge, StagePipeline } from "./stage-pipeline";

function waitingText(run: PayrollRun, name: (id?: string) => string) {
  switch (run.stage) {
    case "draft":
      return "Attendance is still open. The finance duty person locks it and calculates.";
    case "calculated":
      return run.returnedNote ? `Sent back: “${run.returnedNote}”. The finance duty person fixes and prepares it again.` : "Calculated. Waiting for the finance duty person to prepare it.";
    case "prepared":
      return `Waiting for ${name("ACV-0003")} (Director) to review.`;
    case "reviewed":
      return `Waiting for ${name("ACV-0002")} (CEO) to approve.`;
    case "approved":
      return "Approved. Payslips can be sent.";
    case "payslips_sent":
      return "Payslips sent. Ready to post to the ledger.";
    case "posted":
      return "Posted to the ledger. Waiting for the bank transfer.";
    case "paid":
      return `Paid on ${run.paidAt ? formatDate(run.paidAt) : "—"}.`;
  }
}

export function RunsOverview() {
  const router = useRouter();
  const runs = usePayrollRuns();
  const slabs = useTaxSlabs();
  const start = useStartRun();
  const canPrepare = useCan("payroll.prepare");
  const lookup = useLookup();
  const name = (id?: string) => lookup.employee(id)?.name ?? id ?? "—";

  const list = React.useMemo(() => runs.data ?? [], [runs.data]);
  const latest = list[0];
  const nextMonth = latest ? nextMonthKey(latest.month) : monthKey();
  const canStart = latest?.stage === "paid";
  const current = list.find((r) => r.stage !== "paid") ?? latest;

  const fyStart = (() => {
    const now = new Date();
    const y = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    return `${y}-07`;
  })();
  const fyRuns = list.filter((r) => r.month >= fyStart);
  const paid = list.filter((r) => r.stage === "paid");
  const lastPaid = paid[0];
  const ytdGross = fyRuns.filter((r) => r.stage === "paid").reduce((s, r) => s + toNumber(r.totals.gross), 0);
  const ytdTax = fyRuns.filter((r) => r.stage === "paid").reduce((s, r) => s + toNumber(r.totals.tax), 0);

  const chart: EChartOption = React.useMemo(() => {
    const sorted = [...list].sort((a, b) => a.month.localeCompare(b.month));
    const fmt = (v: unknown) => formatMoneyCompact(Number(v));
    return {
      xAxis: { type: "category", data: sorted.map((r) => formatMonthShort(new Date(`${r.month}-15`))), axisTick: { show: false } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatMoneyCompact(v).replace("PKR ", "") } },
      series: [
        { name: "Net pay", type: "bar", stack: "pay", barMaxWidth: 34, tooltip: { valueFormatter: fmt }, data: sorted.map((r) => toNumber(r.totals.net)) },
        { name: "Tax", type: "bar", stack: "pay", barMaxWidth: 34, tooltip: { valueFormatter: fmt }, data: sorted.map((r) => toNumber(r.totals.tax)), itemStyle: { borderRadius: [4, 4, 0, 0] } },
      ],
    };
  }, [list]);

  const startRun = async () => {
    const run = await start.mutateAsync(nextMonth).catch((e: Error) => {
      toast.error(e.message);
      return null;
    });
    if (run) {
      toast.success(`${formatMonthKey(nextMonth)} run started`, { description: "Lock attendance and calculate when the month's attendance is final." });
      router.push(`/payroll/runs/${run.id}`);
    }
  };

  return (
    <>
      <PageHeader
        title="Payroll"
        description="Monthly salaries from profiles and attendance: prepared, reviewed, approved, then posted to the ledger."
        seal="highly"
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/payroll/advances">
                <HandCoins /> Advances
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/payroll/payslips">
                <Receipt /> My payslips
              </Link>
            </Button>
            {canPrepare && (
              <Tip content={canStart ? undefined : `${latest ? formatMonthKey(latest.month) : "The current"} run must be paid first.`}>
                <span tabIndex={canStart ? -1 : 0}>
                  <Button onClick={startRun} disabled={!canStart} loading={start.isPending}>
                    <Play /> Start {formatMonthKey(nextMonth).split(" ")[0]} run
                  </Button>
                </span>
              </Tip>
            )}
          </>
        }
      />

      {runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
      ) : runs.isPending ? (
        <div className="grid gap-6">
          <CardsSkeleton />
          <ListSkeleton rows={4} />
        </div>
      ) : !list.length ? (
        <EmptyState icon={<Banknote />} title="No payroll runs yet" description="The finance duty person starts the first run at month end." />
      ) : (
        <div className="grid gap-6">
          {current && (
            <Card className="overflow-hidden">
              <div className="layer-lines border-b border-border px-5 py-4" style={{ ["--layer-color" as string]: "var(--zone-finance)" }}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zone-finance">{current.stage === "paid" ? "Latest run" : "Current run"}</p>
                    <h2 className="mt-0.5 text-xl font-semibold tracking-tight">{formatMonthKey(current.month)}</h2>
                    <p className="mt-1 text-[13px] text-muted-foreground">{waitingText(current, name)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="text-[12px] text-muted-foreground">Net pay · {current.headcount} people</p>
                      <Money value={current.totals.net} className="text-2xl font-semibold" />
                    </div>
                    <Button asChild>
                      <Link href={`/payroll/runs/${current.id}`}>
                        Open run <ArrowRight />
                      </Link>
                    </Button>
                  </div>
                </div>
              </div>
              <CardContent className="grid gap-5 pt-5">
                <StagePipeline stage={current.stage} />
                <ApprovalRelay steps={current.chain} />
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Last paid net" value={lastPaid ? <Money value={lastPaid.totals.net} compact /> : "—"} hint={lastPaid ? formatMonthKey(lastPaid.month) : undefined} icon={<Banknote />} accent="var(--zone-finance)" />
            <StatCard label="Payroll cost this year" value={<Money value={ytdGross} compact />} hint="Gross since 1 July" icon={<CalendarRange />} accent="var(--zone-finance)" />
            <StatCard label="Tax withheld this year" value={<Money value={ytdTax} compact />} hint="Paid to FBR monthly" icon={<Receipt />} accent="var(--zone-finance)" />
            <StatCard label="On payroll" value={current?.headcount ?? 0} hint="People in the current run" icon={<Users />} accent="var(--zone-finance)" />
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <section>
              <SectionTitle title="All runs" description="Approved runs never change. Fixes go into the next month as an adjustment." />
              <div className="overflow-hidden rounded-xl border border-border bg-card shadow-strata">
                <Table>
                  <THead>
                    <tr>
                      <TH>Month</TH>
                      <TH>Stage</TH>
                      <TH className="hidden 2xl:table-cell">Progress</TH>
                      <TH className="text-right">Gross</TH>
                      <TH className="hidden text-right sm:table-cell">Tax</TH>
                      <TH className="text-right">Net</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {list.map((r) => (
                      <TR key={r.id} className="cursor-pointer" onClick={() => router.push(`/payroll/runs/${r.id}`)}>
                        <TD>
                          <Link href={`/payroll/runs/${r.id}`} className="whitespace-nowrap font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                            {formatMonthKey(r.month)}
                          </Link>
                          <p className="whitespace-nowrap font-mono text-[11.5px] text-muted-foreground">{r.number}</p>
                        </TD>
                        <TD>
                          <StageBadge stage={r.stage} />
                        </TD>
                        <TD className="hidden w-44 2xl:table-cell">
                          <StagePipeline stage={r.stage} compact />
                        </TD>
                        <TD className="text-right">
                          <Money value={r.totals.gross} />
                        </TD>
                        <TD className="hidden text-right sm:table-cell">
                          <Money value={r.totals.tax} className="text-muted-foreground" />
                        </TD>
                        <TD className="text-right font-semibold">
                          <Money value={r.totals.net} />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </section>
            <div className="grid content-start gap-6">
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Net pay and tax by month</CardTitle>
                    <CardDescription>Bars stack to the gross cost after deductions.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  <EChart option={chart} height={220} ariaLabel="Net pay and tax by month" />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Income tax slabs</CardTitle>
                    <CardDescription>Yearly salary income. The accountant updates these in Settings.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  <table className="w-full text-[12.5px]">
                    <tbody>
                      {(slabs.data ?? []).map((s) => (
                        <tr key={s.from} className="border-b border-dashed border-border last:border-0">
                          <td className="py-1.5 font-mono tabular text-muted-foreground">
                            {formatMoneyCompact(s.from).replace("PKR ", "")}–{s.to ? formatMoneyCompact(s.to).replace("PKR ", "") : "above"}
                          </td>
                          <td className="py-1.5 text-right">{s.rate ? `${s.fixed ? `${formatMoneyCompact(s.fixed)} + ` : ""}${(s.rate * 100).toFixed(0)}% over ${formatMoneyCompact(s.from).replace("PKR ", "")}` : "No tax"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
