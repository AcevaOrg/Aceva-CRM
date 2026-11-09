"use client";
/** Home widgets from Insights (M11): company finance KPIs and revenue vs expenses. */
import { useRouter } from "next/navigation";
import { ChartColumn, Landmark, Receipt, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { CardsSkeleton } from "@/components/shared/states";
import { EChart } from "@/components/shared/echart";
import { StatCard } from "@/components/shared/metrics";
import { Money } from "@/components/shared/money";
import { useFinanceKpis, useRevenueExpenseSeries } from "@/features/analysis/hooks";
import { formatMoneyCompact } from "@/lib/format";
import { useCan } from "@/lib/auth/viewer";
import { Widget, WidgetSkeleton } from "./widget";

export function FinanceKpiRow() {
  const allowed = useCan("insights.view");
  const q = useFinanceKpis();
  const router = useRouter();
  if (!allowed) return null;
  if (q.isPending) return <CardsSkeleton count={5} className="xl:grid-cols-5" />;
  const k = q.data;
  if (!k) return null;
  const go = () => router.push("/finance/insights");
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <StatCard label="Cash in bank" value={<Money value={k.cash} compact />} delta={k.cashDelta ?? undefined} icon={<Landmark />} accent="var(--zone-finance)" onClick={go} />
      <StatCard label="Revenue this month" value={<Money value={k.revenue} compact />} delta={k.revenueDelta ?? undefined} icon={<TrendingUp />} accent="var(--success)" onClick={go} />
      <StatCard label="Expenses this month" value={<Money value={k.expenses} compact />} delta={k.expensesDelta ?? undefined} deltaGoodWhen="down" icon={<TrendingDown />} accent="var(--warning)" onClick={go} />
      <StatCard label="Profit this month" value={<Money value={k.profit} compact />} delta={k.profitDelta ?? undefined} icon={<Wallet />} accent="var(--primary)" onClick={go} />
      <StatCard
        label="Unpaid invoices"
        value={<Money value={k.unpaidInvoices} compact />}
        hint={`${k.unpaidCount} open · ${k.overdueCount} overdue`}
        icon={<Receipt />}
        accent={k.overdueCount ? "var(--danger)" : "var(--zone-finance)"}
        onClick={() => router.push("/billing?tab=invoices")}
      />
    </div>
  );
}

export function RevenueExpenseWidget() {
  const allowed = useCan("insights.view");
  const q = useRevenueExpenseSeries();
  if (!allowed) return null;
  const s = q.data;
  return (
    <Widget title="Revenue vs expenses" icon={<ChartColumn />} href="/finance/insights" linkLabel="Insights" seal="highly">
      {q.isPending || !s ? (
        <WidgetSkeleton rows={5} />
      ) : (
        <EChart
          height={240}
          ariaLabel="Revenue and expenses for the last six months"
          option={{
            tooltip: { trigger: "axis", valueFormatter: (v: unknown) => formatMoneyCompact(Number(v), s.currency) },
            legend: { data: ["Revenue", "Expenses", "Profit"] },
            xAxis: { type: "category", data: s.labels },
            yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatMoneyCompact(v, s.currency).replace(`${s.currency} `, "") } },
            series: [
              { name: "Revenue", type: "bar", data: s.revenue, barMaxWidth: 18, itemStyle: { borderRadius: [4, 4, 0, 0] } },
              { name: "Expenses", type: "bar", data: s.expenses, barMaxWidth: 18, itemStyle: { borderRadius: [4, 4, 0, 0] } },
              { name: "Profit", type: "line", data: s.profit, smooth: true, symbolSize: 6 },
            ],
          }}
        />
      )}
    </Widget>
  );
}
