"use client";
/** Small building blocks for the performance screens. */
import * as React from "react";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tip } from "@/components/ui/overlays";
import { statusMap } from "@/components/shared/chips";
import { EChart } from "@/components/shared/echart";
import { ScoreDial } from "@/components/shared/metrics";
import { formatMonthKey } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { BAND_LABEL, BAND_TONE, contributions, metricDefs, UNMEASURED_TEXT, unmeasuredReason } from "../logic";
import type { Band, MetricSet, SalesMetricSet, ScorecardKind, ScorecardStatus, TrendPoint, UnmeasuredMetric } from "../types";

export const SCORECARD_STATUS = statusMap<ScorecardStatus>({
  draft: { label: "Draft · with reviewer", tone: "warning" },
  released: { label: "Released", tone: "info" },
  acknowledged: { label: "Acknowledged", tone: "success" },
});

/** The band of a score; "No score yet" when nothing could be measured (never a made-up band). */
export function BandBadge({ band, className }: { band: Band | null; className?: string }) {
  if (!band)
    return (
      <Badge tone="outline" className={className}>
        No score yet
      </Badge>
    );
  return (
    <Badge tone={BAND_TONE[band]} dot className={className}>
      {BAND_LABEL[band]}
    </Badge>
  );
}

/** The score dial; an empty grey dial with "No score yet" when the score is null (nothing could be measured). */
export function ScoreDialOrNone({ score, size = 132, showBand = true, label }: { score: number | null; size?: number; showBand?: boolean; label?: string }) {
  if (score !== null) return <ScoreDial score={score} size={size} showBand={showBand} label={label} />;
  const stroke = Math.max(8, size * 0.08);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative inline-grid place-items-center" style={{ width: size, height: size }} role="img" aria-label="No score yet">
      <svg width={size} height={size} className="rotate-[135deg]">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} strokeDasharray={`${c * 0.75} ${c}`} strokeLinecap="round" />
      </svg>
      <div className="absolute grid place-items-center text-center">
        <span className="font-semibold leading-none text-muted-foreground" style={{ fontSize: size * 0.27 }}>
          —
        </span>
        <span className="mt-1 text-[10px] font-semibold uppercase leading-tight tracking-wide text-muted-foreground">No score yet</span>
      </div>
    </div>
  );
}

/**
 * Says which figures are not available yet and why (attendance until the Attendance module, sales figures until the
 * Sales module, or nothing to measure this month), and that the score uses only the figures that exist.
 */
export function UnmeasuredNotice({ kind, unmeasured, className }: { kind: ScorecardKind; unmeasured?: UnmeasuredMetric[]; className?: string }) {
  if (!unmeasured?.length) return null;
  const defs = metricDefs(kind);
  const names = unmeasured.map((u) => defs.find((d) => d.key === u.key)?.label ?? u.key);
  const reasons = [...new Set(unmeasured.map((u) => u.reason))].map((r) => UNMEASURED_TEXT[r]);
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-[12.5px]", className)}>
      <Info className="mt-0.5 size-4 shrink-0 text-info" />
      <div className="grid gap-1">
        <p>
          <span className="font-semibold">Not available yet: {names.join(", ")}.</span> {reasons.join(" ")}
        </p>
        <p className="text-muted-foreground">The score uses only the figures that exist; the weights of the others are shared between them, so nobody gains or loses points for a missing figure.</p>
      </div>
    </div>
  );
}

const barColor = (v: number, lowerIsBetter?: boolean) => {
  const good = lowerIsBetter ? 100 - v : v;
  return good >= 85 ? "var(--success)" : good >= 70 ? "var(--primary)" : good >= 50 ? "var(--warning)" : "var(--danger)";
};

const pct = (fraction: number) => Math.round(fraction * 100);

/** Five metric tiles, each 0–100 (or "Not available yet"), with "how it's calculated" tooltips. */
export function MetricTiles({
  kind,
  metrics,
  weights,
  unmeasured,
  className,
}: {
  kind: ScorecardKind;
  metrics: MetricSet | SalesMetricSet;
  weights: Record<string, number>;
  unmeasured?: UnmeasuredMetric[];
  className?: string;
}) {
  const rows = contributions(kind, metrics, weights);
  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5", className)}>
      {rows.map(({ def, raw, weight, baseWeight, measured }) => {
        const scaled = measured && pct(weight) !== pct(baseWeight);
        return (
          <Card key={def.key} className="grid gap-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12.5px] font-medium text-muted-foreground">
                <span className="mr-1.5 inline-grid size-5 place-content-center rounded-md bg-muted font-mono text-[11px] font-bold text-foreground">{def.letter}</span>
                {def.label}
              </p>
              <Tip
                content={
                  <span className="grid gap-1">
                    <span>{def.how}</span>
                    <span className="opacity-80">Weight {pct(baseWeight)}%</span>
                    {scaled && <span className="opacity-80">Counts as {pct(weight)}% of this score while some figures are not available.</span>}
                    {!measured && <span className="opacity-80">{unmeasuredReason(unmeasured, def.key)}</span>}
                  </span>
                }
              >
                <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label={`How ${def.label} is calculated`}>
                  <Info className="size-3.5" />
                </button>
              </Tip>
            </div>
            {raw !== null ? (
              <>
                <p className="text-[26px] font-semibold leading-none tabular">{Math.round(raw)}</p>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, raw)}%`, background: barColor(raw, def.lowerIsBetter) }} />
                </div>
                <p className="text-[11.5px] text-muted-foreground">{def.lowerIsBetter ? "Lower is better" : `Weight ${pct(baseWeight)}%`}</p>
              </>
            ) : (
              <>
                <p className="flex h-[26px] items-center text-[14px] font-semibold leading-none text-muted-foreground">Not available yet</p>
                <div className="h-1.5 rounded-full bg-muted" />
                <p className="text-[11.5px] leading-snug text-muted-foreground">{unmeasuredReason(unmeasured, def.key)}</p>
              </>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/**
 * The formula with each measured metric's points (two decimals), using the scorecard's saved weights (unmeasured
 * metrics are left out). The total is the sum of the unrounded points rounded once to one decimal, so the chips can add
 * up to a hundredth or so off the total; the note beside it says so.
 */
export function FormulaLine({
  kind,
  metrics,
  weights,
  score,
}: {
  kind: ScorecardKind;
  metrics: MetricSet | SalesMetricSet;
  weights: Record<string, number>;
  score: number | null;
}) {
  const all = contributions(kind, metrics, weights);
  const rows = all.filter((r) => r.measured);
  const left = all.filter((r) => !r.measured).map((r) => r.def.label);
  if (rows.length === 0)
    return (
      <p className="font-mono text-[12px] text-muted-foreground">
        {kind === "sales" ? "Sales score" : "Score"} = no figure to work it out from yet
      </p>
    );
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
            <Tip content={`${r.def.label}: ${Number((r.used as number).toFixed(1))} × ${Number(r.weight.toFixed(4))} = ${(r.points as number).toFixed(2)}`}>
              <span tabIndex={0} className="rounded-md bg-muted px-1.5 py-0.5 outline-none">
                {(r.points as number).toFixed(2)}
              </span>
            </Tip>
          </React.Fragment>
        ))}
        <span className="text-muted-foreground">=</span>
        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-semibold">{score === null ? "—" : score.toFixed(1)}</span>
        {score !== null && <span className="font-sans text-[11px] text-muted-foreground">total rounded to 1 decimal</span>}
      </div>
      {left.length > 0 && <p className="text-[11.5px] text-muted-foreground">Not counted yet: {left.join(", ")}. Their weight is shared between the others.</p>}
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

/**
 * Closed months, then this month so far (dashed). `liveMonth` is the month the live point belongs to: the server leaves
 * this month out of the trend when nothing could be measured yet, and then every point is a closed month.
 */
export function TrendChart({ trend, height = 240, liveMonth }: { trend: TrendPoint[]; height?: number; liveMonth?: string }) {
  if (trend.length === 0) return <p className="py-6 text-center text-[13px] text-muted-foreground">No scored month yet.</p>;
  const lastIdx = trend.length - 1;
  const hasLive = liveMonth === undefined || trend[lastIdx].month === liveMonth;
  const short = (m: string) => formatMonthKey(m).split(" ")[0].slice(0, 3);
  const labels = trend.map((t, i) => (hasLive && i === lastIdx ? `${short(t.month)} (so far)` : short(t.month)));
  const closed = trend.map((t, i) => (hasLive && i === lastIdx ? null : Math.round(t.score)));
  const live = trend.map((t, i) => (hasLive && i >= lastIdx - 1 ? Math.round(t.score) : null));
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
