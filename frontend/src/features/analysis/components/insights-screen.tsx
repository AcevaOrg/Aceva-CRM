"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Banknote, CircleDollarSign, FileWarning, TrendingDown, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { RequireAccess } from "@/components/shared/can";
import { DataTable } from "@/components/shared/data-table";
import { EChart, type EChartOption } from "@/components/shared/echart";
import { StatCard } from "@/components/shared/metrics";
import { Money, Mono } from "@/components/shared/money";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/shared/states";
import { formatDate, formatMonthKey } from "@/lib/dates";
import { formatMoney, formatMoneyCompact } from "@/lib/format";
import type { Currency } from "@/types";
import { useDrill, useInsights } from "../hooks";
import type { DrillKind, InsightsParams } from "../types";

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ranges() {
  const now = new Date();
  const fy = new Date(now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1, 6, 1);
  return [
    { key: "6m", label: "Last 6 months", from: ymd(new Date(now.getFullYear(), now.getMonth() - 5, 1)), to: ymd(now) },
    { key: "fy", label: "This finance year", from: ymd(fy), to: ymd(now) },
    { key: "3m", label: "Last 3 months", from: ymd(new Date(now.getFullYear(), now.getMonth() - 2, 1)), to: ymd(now) },
    { key: "1m", label: "This month", from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) },
  ];
}

const compact = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}K` : String(Math.round(a));
  return `${n < 0 ? "−" : ""}${s}`;
};

/** Canvas charts need real colours, not CSS variables. */
function css(name: string) {
  if (typeof window === "undefined") return "#888";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

interface Drill {
  kind: DrillKind;
  key: string;
  title: string;
}

export function InsightsScreen() {
  return (
    <RequireAccess permission="insights.view" mode="404">
      <Insights />
    </RequireAccess>
  );
}

function Insights() {
  const R = React.useMemo(() => ranges(), []);
  const [rangeKey, setRangeKey] = React.useState("6m");
  const [currency, setCurrency] = React.useState<Currency>("PKR");
  const range = R.find((r) => r.key === rangeKey) ?? R[0];
  const params: InsightsParams = { from: range.from, to: range.to, currency };
  const q = useInsights(params);
  const [drill, setDrill] = React.useState<Drill | null>(null);
  const d = q.data;
  const fmt = (n: number) => formatMoney(n, { currency });
  const tooltipMoney = { valueFormatter: (v: number) => fmt(v) };

  const { resolvedTheme } = useTheme();
  const charts = React.useMemo(() => {
    if (!d) return null;
    const s = d.series;
    const revExp: EChartOption = {
      tooltip: tooltipMoney,
      legend: { data: ["Revenue", "Expenses"] },
      xAxis: { type: "category", data: s.labels },
      yAxis: { type: "value", axisLabel: { formatter: compact } },
      series: [
        { name: "Revenue", type: "bar", data: s.revenue, itemStyle: { borderRadius: [5, 5, 0, 0] }, barMaxWidth: 26 },
        { name: "Expenses", type: "bar", data: s.expenses, itemStyle: { borderRadius: [5, 5, 0, 0], color: css("--chart-3") }, barMaxWidth: 26 },
      ],
    };
    const profit: EChartOption = {
      tooltip: tooltipMoney,
      xAxis: { type: "category", data: s.labels, boundaryGap: false },
      yAxis: { type: "value", axisLabel: { formatter: compact } },
      series: [
        {
          name: "Net profit",
          type: "line",
          data: s.profit,
          smooth: 0.3,
          symbolSize: 8,
          lineStyle: { width: 3 },
          markLine: { silent: true, symbol: "none", data: [{ yAxis: 0 }], lineStyle: { type: "dashed" }, label: { show: false } },
        },
      ],
    };
    const cash: EChartOption = {
      tooltip: tooltipMoney,
      xAxis: { type: "category", data: s.labels, boundaryGap: false },
      yAxis: { type: "value", axisLabel: { formatter: compact } },
      series: [{ name: "Cash and bank", type: "line", data: s.cash, smooth: 0.3, symbolSize: 7, areaStyle: { opacity: 0.18 }, lineStyle: { width: 2.5 }, itemStyle: { color: css("--chart-2") } }],
    };
    const donut: EChartOption = {
      tooltip: { trigger: "item", valueFormatter: (v: number) => fmt(v) },
      legend: { orient: "vertical", left: 0, top: "middle", type: "scroll" },
      series: [
        {
          name: "Expenses",
          type: "pie",
          radius: ["52%", "78%"],
          center: ["68%", "50%"],
          avoidLabelOverlap: true,
          itemStyle: { borderColor: css("--card"), borderWidth: 2, borderRadius: 4 },
          label: { show: false },
          data: d.expenseBreakdown.map((x) => ({ name: x.name, value: x.value, key: x.key, ...(x.key === "other" ? { itemStyle: { color: css("--muted-foreground") } } : {}) })),
        },
      ],
    };
    const aging: EChartOption = {
      tooltip: tooltipMoney,
      xAxis: { type: "category", data: d.aging.map((a) => a.label) },
      yAxis: { type: "value", axisLabel: { formatter: compact } },
      series: [
        {
          name: "Unpaid",
          type: "bar",
          barMaxWidth: 42,
          data: d.aging.map((a, i) => ({ value: a.value, key: a.key, itemStyle: { borderRadius: [5, 5, 0, 0], color: [css("--chart-2"), css("--warning"), css("--chart-3"), css("--danger"), css("--danger")][i] } })),
        },
      ],
    };
    const projects = [...d.projects].reverse();
    const proj: EChartOption = {
      tooltip: { ...tooltipMoney, axisPointer: { type: "shadow" } },
      grid: { left: 8, right: 16, top: 8, bottom: 4, containLabel: true },
      xAxis: { type: "value", axisLabel: { formatter: compact } },
      yAxis: { type: "category", data: projects.map((p) => p.name), axisLabel: { width: 150, overflow: "truncate" } },
      series: [{ name: "Profit", type: "bar", barMaxWidth: 18, data: projects.map((p) => ({ value: p.profit, key: p.key, itemStyle: { borderRadius: [0, 5, 5, 0], color: p.profit < 0 ? css("--danger") : css("--chart-4") } })) }],
    };
    return { revExp, profit, cash, donut, aging, proj };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, currency, resolvedTheme]);

  const k = d?.kpis;

  return (
    <>
      <PageHeader
        title="Insights"
        description="Graphs drawn from the same ledger as the statements. Click a bar or a slice to see the entries behind it."
        seal="highly"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect value={rangeKey} onChange={(e) => setRangeKey(e.target.value)} aria-label="Date range" className="w-48">
              {R.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </NativeSelect>
            <SegmentedControl value={currency} onChange={setCurrency} options={[{ value: "PKR", label: "PKR" }, { value: "USD", label: "USD" }]} ariaLabel="Currency" />
          </div>
        }
      />

      {q.isPending ? (
        <CardsSkeleton count={5} className="xl:grid-cols-5" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        k &&
        charts && (
          <>
            <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              <StatCard label="Cash in bank" value={formatMoneyCompact(k.cash)} delta={k.cashDelta ?? undefined} hint="vs end of last month" icon={<Banknote />} accent="var(--chart-2)" />
              <StatCard label="Revenue this month" value={formatMoneyCompact(k.revenue)} delta={k.revenueDelta ?? undefined} hint="vs same days" icon={<TrendingUp />} accent="var(--chart-1)" />
              <StatCard label="Expenses this month" value={formatMoneyCompact(k.expenses)} delta={k.expensesDelta ?? undefined} deltaGoodWhen="down" hint="vs same days" icon={<TrendingDown />} accent="var(--chart-3)" />
              <StatCard label="Profit this month" value={formatMoneyCompact(k.profit)} delta={k.profitDelta ?? undefined} hint="month to date" icon={<CircleDollarSign />} accent="var(--chart-4)" />
              <StatCard
                label="Unpaid invoices"
                value={formatMoneyCompact(k.unpaidInvoices)}
                hint={`${k.unpaidCount} invoices · ${k.overdueCount} overdue`}
                icon={<FileWarning />}
                accent={k.overdueCount ? css("--danger") : undefined}
                onClick={() => setDrill({ kind: "aging-bucket", key: "b30", title: "Invoices 1–30 days overdue" })}
              />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <ChartCard title="Revenue vs expenses by month" question="Is Aceva earning more than it spends?">
                <EChart
                  option={charts.revExp}
                  ariaLabel="Revenue and expenses by month"
                  onClick={(p) => {
                    const m = d!.series.months[p.dataIndex];
                    const rev = p.seriesName === "Revenue";
                    setDrill({ kind: rev ? "revenue-month" : "expense-month", key: m, title: `${rev ? "Revenue" : "Expenses"} in ${formatMonthKey(m)}` });
                  }}
                />
              </ChartCard>
              <ChartCard title="Net profit trend" question="Is profit growing?">
                <EChart option={charts.profit} ariaLabel="Net profit by month" onClick={(p) => setDrill({ kind: "profit-month", key: d!.series.months[p.dataIndex], title: `Profit and loss lines in ${formatMonthKey(d!.series.months[p.dataIndex])}` })} />
              </ChartCard>
              <ChartCard title="Cash balance over time" question="How much cash is available?">
                <EChart option={charts.cash} ariaLabel="Cash and bank at each month end" onClick={(p) => setDrill({ kind: "cash-month", key: d!.series.months[p.dataIndex], title: `Cash movements in ${formatMonthKey(d!.series.months[p.dataIndex])}` })} />
              </ChartCard>
              <ChartCard title="Expense breakdown by category" question="Where does the money go?">
                {d!.expenseBreakdown.length ? (
                  <EChart option={charts.donut} ariaLabel="Expenses by category" onClick={(p) => setDrill({ kind: "expense-account", key: (p.data as { key: string }).key, title: `${p.name} (${range.label.toLowerCase()})` })} />
                ) : (
                  <EmptyState compact title="No expenses in this range" />
                )}
              </ChartCard>
              <ChartCard title="Unpaid invoices by age" question="Which client payments are late?">
                <EChart option={charts.aging} ariaLabel="Unpaid invoices by age" onClick={(p) => setDrill({ kind: "aging-bucket", key: (p.data as { key: string }).key, title: `Unpaid invoices: ${p.name}` })} />
              </ChartCard>
              <ChartCard title="Profit by project or client" question="Which work earns the most?">
                <EChart option={charts.proj} ariaLabel="Profit by project" onClick={(p) => setDrill({ kind: "project", key: (p.data as { key: string }).key, title: `${p.name}: revenue and direct costs` })} />
              </ChartCard>
            </div>
          </>
        )
      )}
      {drill && <DrillSheet drill={drill} params={params} onClose={() => setDrill(null)} />}
    </>
  );
}

function ChartCard({ title, question, children }: { title: string; question: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{question}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function DrillSheet({ drill, params, onClose }: { drill: Drill; params: InsightsParams; onClose: () => void }) {
  const router = useRouter();
  const q = useDrill(drill.kind, drill.key, params);
  const total = (q.data ?? []).reduce((s, l) => s + l.amount, 0);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="xl">
        <SheetHeader>
          <SheetTitle>{drill.title}</SheetTitle>
          <SheetDescription>
            {q.data ? `${q.data.length} lines · total ` : "Loading…"}
            {q.data && <Money value={total} currency={params.currency} exact />}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : (
            <DataTable
              rows={q.data}
              loading={q.isPending}
              rowKey={(l) => l.key}
              onRowClick={(l) => l.entryId && router.push(`/finance/ledger/${l.entryId}`)}
              pageSize={12}
              dense
              columns={[
                { key: "number", header: "Entry", cell: (l) => <Mono className="whitespace-nowrap text-[12.5px]">{l.number}</Mono>, sortValue: (l) => l.number },
                { key: "date", header: "Date", cell: (l) => formatDate(l.date), sortValue: (l) => l.date },
                { key: "label", header: "Account or client", cell: (l) => l.label, hideOnMobile: true },
                { key: "desc", header: "Description", cell: (l) => <span className="line-clamp-1">{l.description}</span> },
                { key: "amount", header: "Amount", align: "right", cell: (l) => <Money value={l.amount} currency={params.currency} exact tone="auto" />, sortValue: (l) => l.amount },
              ]}
              empty={<EmptyState compact title="Nothing behind this point" />}
            />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
