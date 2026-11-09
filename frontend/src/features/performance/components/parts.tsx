"use client";
/** Small building blocks for the performance screens. */
import * as React from "react";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tip } from "@/components/ui/overlays";
import { statusMap } from "@/components/shared/chips";
import { EChart } from "@/components/shared/echart";
import { formatMonthKey } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { BAND_LABEL, BAND_TONE, contributions, metricDefs } from "../logic";
import type { Band, MetricSet, SalesMetricSet, ScorecardKind, ScorecardStatus, TrendPoint } from "../types";

export const SCORECARD_STATUS = statusMap<ScorecardStatus>({
  draft: { label: "Draft · with reviewer", tone: "warning" },
  released: { label: "Released", tone: "info" },
  acknowledged: { label: "Acknowledged", tone: "success" },
});

export function BandBadge({ band, className }: { band: Band; className?: string }) {
  return (
    <Badge tone={BAND_TONE[band]} dot className={className}>
      {BAND_LABEL[band]}
    </Badge>
  );
}

const barColor = (v: number, lowerIsBetter?: boolean) => {
  const good = lowerIsBetter ? 100 - v : v;
  return good >= 85 ? "var(--success)" : good >= 70 ? "var(--primary)" : good >= 50 ? "var(--warning)" : "var(--danger)";
};

/** Five metric tiles, each 0–100, with "how it's calculated" tooltips. */
export function MetricTiles({
  kind,
  metrics,
  weights,
  className,
}: {
  kind: ScorecardKind;
  metrics: MetricSet | SalesMetricSet;
  weights: Record<string, number>;
  className?: string;
}) {
  const rows = contributions(kind, metrics, weights);
  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5", className)}>
      {rows.map(({ def, raw, weight }) => (
        <Card key={def.key} className="grid gap-2 p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[12.5px] font-medium text-muted-foreground">
              <span className="mr-1.5 inline-grid size-5 place-content-center rounded-md bg-muted font-mono text-[11px] font-bold text-foreground">{def.letter}</span>
              {def.label}
            </p>
            <Tip content={<span className="grid gap-1"><span>{def.how}</span><span className="opacity-80">Weight {Math.round(weight * 100)}%</span></span>}>
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label={`How ${def.label} is calculated`}>
                <Info className="size-3.5" />
              </button>
            </Tip>
          </div>
          <p className="text-[26px] font-semibold leading-none tabular">{Math.round(raw)}</p>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, raw)}%`, background: barColor(raw, def.lowerIsBetter) }} />
          </div>
          <p className="text-[11.5px] text-muted-foreground">{def.lowerIsBetter ? "Lower is better" : `Weight ${Math.round(weight * 100)}%`}</p>
        </Card>
      ))}
    </div>
  );
}

/** The formula with each metric's points, using the scorecard's saved weights. */
export function FormulaLine({ kind, metrics, weights, score }: { kind: ScorecardKind; metrics: MetricSet | SalesMetricSet; weights: Record<string, number>; score: number }) {
  const rows = contributions(kind, metrics, weights);
  return (
    <div className="grid gap-2">
      <p className="font-mono text-[12px] text-muted-foreground">
        {kind === "sales" ? "Sales score" : "Score"} ={" "}
        {rows.map((r, i) => (
          <span key={r.def.key}>
            {i > 0 && " + "}
            {r.weight.toFixed(2)}&nbsp;{r.def.lowerIsBetter ? `(100 − ${r.def.letter})` : r.def.letter}
          </span>
        ))}
      </p>
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[12px] tabular">
        {rows.map((r, i) => (
          <React.Fragment key={r.def.key}>
            {i > 0 && <span className="text-muted-foreground">+</span>}
            <Tip content={`${r.def.label}: ${Math.round(r.used)} × ${r.weight}`}>
              <span tabIndex={0} className="rounded-md bg-muted px-1.5 py-0.5 outline-none">
                {r.points.toFixed(1)}
              </span>
            </Tip>
          </React.Fragment>
        ))}
        <span className="text-muted-foreground">=</span>
        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-semibold">{score.toFixed(1)}</span>
      </div>
    </div>
  );
}

/** Tiny inline trend line. */
export function Sparkline({ points, width = 96, height = 28 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) return <span className="text-muted-foreground">—</span>;
  const min = Math.min(...points, 40);
  const max = Math.max(...points, 100);
  const step = width / (points.length - 1);
  const y = (v: number) => height - 3 - ((v - min) / (max - min || 1)) * (height - 6);
  const d = points.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const up = last >= points[points.length - 2];
  return (
    <svg width={width} height={height} role="img" aria-label={`Trend: ${points.map((p) => Math.round(p)).join(", ")}`}>
      <path d={d} fill="none" stroke="var(--primary)" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={(points.length - 1) * step} cy={y(last)} r={2.6} fill={up ? "var(--success)" : "var(--danger)"} />
    </svg>
  );
}

/** Six closed months + the live month (dashed). */
export function TrendChart({ trend, height = 240 }: { trend: TrendPoint[]; height?: number }) {
  const labels = trend.map((t, i) => (i === trend.length - 1 ? `${formatMonthKey(t.month).split(" ")[0].slice(0, 3)} (so far)` : formatMonthKey(t.month).split(" ")[0].slice(0, 3)));
  const closed = trend.map((t, i) => (i < trend.length - 1 ? Math.round(t.score) : null));
  const live = trend.map((t, i) => (i >= trend.length - 2 ? Math.round(t.score) : null));
  return (
    <EChart
      height={height}
      ariaLabel="Score trend over the last months"
      option={{
        grid: { left: 4, right: 12, top: 16, bottom: 4, containLabel: true },
        legend: { show: false },
        tooltip: { trigger: "axis", valueFormatter: (v: unknown) => (v == null ? "—" : `${v}`) },
        xAxis: { type: "category", data: labels, boundaryGap: false },
        yAxis: { type: "value", min: 0, max: 100, interval: 25 },
        series: [
          {
            name: "Score",
            type: "line",
            data: closed,
            smooth: 0.3,
            symbolSize: 7,
            lineStyle: { width: 2.5 },
            areaStyle: { opacity: 0.08 },
            markLine: {
              silent: true,
              symbol: "none",
              label: { position: "insideEndTop", fontSize: 10 },
              lineStyle: { type: "dashed", opacity: 0.45 },
              data: [
                { yAxis: 85, name: "Excellent", label: { formatter: "Excellent 85" } },
                { yAxis: 70, name: "Good", label: { formatter: "Good 70" } },
              ],
            },
          },
          { name: "This month (live)", type: "line", data: live, symbolSize: 7, lineStyle: { type: "dashed", width: 2 } },
        ],
      }}
    />
  );
}

export function metricLetters(kind: ScorecardKind) {
  return metricDefs(kind).map((d) => d.letter);
}
