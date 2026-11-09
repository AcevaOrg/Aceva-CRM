"use client";
/**
 * ECharts wrapper (plan §3: Apache ECharts). Modular imports keep the bundle small.
 * Colours come from the Strata chart tokens; text/grid colours follow the theme.
 *
 *   <EChart option={{ xAxis: {...}, series: [...] }} height={280} onClick={(p) => …} />
 */
import * as React from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, FunnelChart, ScatterChart } from "echarts/charts";
import { DatasetComponent, GridComponent, LegendComponent, TooltipComponent, MarkLineComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
// ECharts 6 moved `grid.containLabel` (keeps axis labels inside the chart) into this opt-in feature.
import { LegacyGridContainLabel } from "echarts/features";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

echarts.use([BarChart, LineChart, PieChart, FunnelChart, ScatterChart, GridComponent, TooltipComponent, LegendComponent, DatasetComponent, MarkLineComponent, CanvasRenderer, LegacyGridContainLabel]);

export type EChartOption = echarts.EChartsCoreOption;
export type EChartClick = { name: string; seriesName?: string; value: unknown; dataIndex: number; data: unknown };

function cssVar(name: string) {
  if (typeof window === "undefined") return "#888";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

export function chartPalette() {
  return [1, 2, 3, 4, 5, 6].map((i) => cssVar(`--chart-${i}`));
}

export function EChart({
  option,
  height = 280,
  className,
  onClick,
  ariaLabel,
}: {
  option: EChartOption;
  height?: number;
  className?: string;
  onClick?: (p: EChartClick) => void;
  ariaLabel?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<echarts.ECharts | null>(null);
  const { resolvedTheme } = useTheme();
  const clickRef = React.useRef(onClick);
  React.useEffect(() => {
    clickRef.current = onClick;
  }, [onClick]);

  React.useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    chart.on("click", (p) => clickRef.current?.(p as unknown as EChartClick));
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const text = cssVar("--muted-foreground");
    const border = cssVar("--border");
    const fg = cssVar("--foreground");
    const pop = cssVar("--popover");
    type Obj = Record<string, unknown>;
    const axis: Obj = { axisLine: { lineStyle: { color: border } }, axisTick: { show: false }, axisLabel: { color: text, fontSize: 11 }, splitLine: { lineStyle: { color: border, type: "dashed" } }, nameTextStyle: { color: text } };
    const tooltip: Obj = { trigger: "axis", backgroundColor: pop, borderColor: border, textStyle: { color: fg, fontSize: 12 }, confine: true };
    const legend: Obj = { top: 0, right: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: text, fontSize: 11.5 } };
    // Theme defaults are merged into whatever the module passes, one level deep for style objects.
    const merge = (base: Obj, over: unknown): Obj => {
      if (!over || typeof over !== "object") return base;
      const o = over as Obj;
      const out: Obj = { ...base, ...o };
      for (const k of Object.keys(base)) {
        if (base[k] && typeof base[k] === "object" && o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) out[k] = { ...(base[k] as Obj), ...(o[k] as Obj) };
      }
      return out;
    };
    const mergeAxis = (over: unknown) => (Array.isArray(over) ? over.map((a) => merge(axis, a)) : merge(axis, over));
    const opt = option as Obj;
    const hasAxes = "xAxis" in opt || "yAxis" in opt || !("series" in opt) || JSON.stringify(opt.series ?? "").match(/"type":"(bar|line|scatter)"/);
    chart.setOption(
      {
        color: chartPalette(),
        textStyle: { fontFamily: "var(--font-geist-sans), system-ui, sans-serif", color: fg },
        grid: { left: 8, right: 12, top: 28, bottom: 4, containLabel: true },
        ...opt,
        tooltip: merge(tooltip, opt.tooltip),
        legend: Array.isArray(opt.legend) ? opt.legend : merge(legend, opt.legend),
        ...(hasAxes ? { xAxis: mergeAxis(opt.xAxis ?? {}), yAxis: mergeAxis(opt.yAxis ?? {}) } : {}),
      },
      { notMerge: true },
    );
  }, [option, resolvedTheme]);

  return <div ref={ref} role="img" aria-label={ariaLabel} className={cn("w-full", onClick && "cursor-pointer", className)} style={{ height }} />;
}
