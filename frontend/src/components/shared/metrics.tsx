"use client";
/** KPI and gauge widgets: StatCard, ScoreDial, ProgressRing, WorkloadBar, scoreBand. */
import * as React from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Tip } from "@/components/ui/overlays";
import { cn, clamp } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  delta,
  deltaGoodWhen = "up",
  icon,
  accent,
  className,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** Percentage change vs the previous period. */
  delta?: number;
  deltaGoodWhen?: "up" | "down";
  icon?: React.ReactNode;
  /** CSS colour for the left accent bar, e.g. "var(--zone-finance)". */
  accent?: string;
  className?: string;
  onClick?: () => void;
}) {
  const good = delta === undefined ? undefined : deltaGoodWhen === "up" ? delta >= 0 : delta <= 0;
  const Comp = onClick ? "button" : "div";
  return (
    <Card className={cn("relative overflow-hidden", onClick && "transition hover:-translate-y-0.5 hover:shadow-float", className)}>
      {accent && <span className="absolute inset-y-0 left-0 w-1" style={{ background: accent }} aria-hidden />}
      <Comp onClick={onClick} className="block w-full px-5 py-4 text-left">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12.5px] font-medium text-muted-foreground">{label}</p>
          {icon && <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>}
        </div>
        <div className="mt-1.5 text-[26px] font-semibold leading-tight tracking-tight tabular">{value}</div>
        <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
          {delta !== undefined && (
            <span className={cn("inline-flex items-center gap-0.5 font-medium", good ? "text-success" : "text-danger")}>
              {delta >= 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
              {Math.abs(delta).toFixed(1)}%
            </span>
          )}
          {hint}
        </div>
      </Comp>
    </Card>
  );
}

export type Band = "excellent" | "good" | "needs_improvement" | "poor";

export function scoreBand(score: number): { band: Band; label: string; color: string } {
  if (score >= 85) return { band: "excellent", label: "Excellent", color: "var(--success)" };
  if (score >= 70) return { band: "good", label: "Good", color: "var(--primary)" };
  if (score >= 50) return { band: "needs_improvement", label: "Needs improvement", color: "var(--warning)" };
  return { band: "poor", label: "Poor", color: "var(--danger)" };
}

/** 270° score ring 0–100 coloured by band (spec §3.5.11). */
export function ScoreDial({ score, size = 132, label, showBand = true }: { score: number; size?: number; label?: string; showBand?: boolean }) {
  const b = scoreBand(score);
  const stroke = Math.max(8, size * 0.08);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const arc = c * 0.75;
  const val = arc * (clamp(score, 0, 100) / 100);
  return (
    <div className="relative inline-grid place-items-center" style={{ width: size, height: size }} role="img" aria-label={`Score ${Math.round(score)} of 100, ${b.label}`}>
      <svg width={size} height={size} className="rotate-[135deg]">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} strokeDasharray={`${arc} ${c}`} strokeLinecap="round" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={b.color}
          strokeWidth={stroke}
          strokeDasharray={`${val} ${c}`}
          strokeLinecap="round"
          className="transition-[stroke-dasharray] duration-700"
        />
      </svg>
      <div className="absolute grid place-items-center text-center">
        <span className="font-semibold tabular leading-none" style={{ fontSize: size * 0.27 }}>
          {Math.round(score)}
        </span>
        {showBand && (
          <span
            className="mt-1 text-balance text-center font-semibold uppercase leading-tight tracking-wide"
            style={{ color: b.color, maxWidth: size * 0.62, fontSize: Math.max(9, Math.min(11, size * ((label ?? b.label).length > 10 ? 0.065 : 0.083))) }}
          >
            {label ?? b.label}
          </span>
        )}
      </div>
    </div>
  );
}

/** Small progress ring for targets ("35 / 30"). */
export function ProgressRing({
  value,
  target,
  size = 76,
  label,
  color = "var(--primary)",
}: {
  value: number;
  target: number;
  size?: number;
  label?: string;
  color?: string;
}) {
  const pct = target > 0 ? clamp(value / target, 0, 1) : 0;
  const met = target > 0 && value >= target;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="grid justify-items-center gap-1.5">
      <div className="relative" style={{ width: size, height: size }} role="img" aria-label={`${label ?? ""} ${value} of ${target}`}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={met ? "var(--success)" : color}
            strokeWidth={stroke}
            strokeDasharray={`${c * pct} ${c}`}
            strokeLinecap="round"
            className="transition-[stroke-dasharray] duration-700"
          />
        </svg>
        <div className="absolute inset-0 grid place-content-center text-center leading-none">
          <span className="text-[17px] font-semibold tabular">{value}</span>
          <span className="mt-0.5 text-[10.5px] text-muted-foreground tabular">of {target}</span>
        </div>
      </div>
      {label && <span className="text-center text-[12px] font-medium text-muted-foreground">{label}</span>}
    </div>
  );
}

/** Open hours vs weekly capacity; overload hatched red (spec §3.5.10). */
export function WorkloadBar({ hours, capacity, compact, className }: { hours: number; capacity: number; compact?: boolean; className?: string }) {
  const over = Math.max(0, hours - capacity);
  const scale = Math.max(capacity, hours) || 1;
  const within = Math.min(hours, capacity);
  const pct = (hours / (capacity || 1)) * 100;
  const tone = pct > 100 ? "bg-danger" : pct > 85 ? "bg-warning" : "bg-zone-work";
  return (
    <Tip content={`${hours} h open of ${capacity} h weekly capacity${over ? ` · ${over} h over` : ""}`}>
      <div tabIndex={0} className={cn("grid gap-1 outline-none", className)}>
        <div className={cn("relative flex overflow-hidden rounded-full bg-muted", compact ? "h-1.5" : "h-2.5")}>
          <div className={cn("h-full", tone)} style={{ width: `${(within / scale) * 100}%` }} />
          {over > 0 && (
            <div
              className="h-full bg-danger/70"
              style={{ width: `${(over / scale) * 100}%`, backgroundImage: "repeating-linear-gradient(45deg, transparent 0 3px, oklch(1 0 0 / 0.35) 3px 6px)" }}
            />
          )}
          {hours > capacity && <span className="absolute inset-y-0 w-px bg-foreground/50" style={{ left: `${(capacity / scale) * 100}%` }} />}
        </div>
        {!compact && (
          <div className="flex justify-between text-[11.5px] text-muted-foreground tabular">
            <span className={cn(over > 0 && "font-semibold text-danger")}>{hours} h open</span>
            <span>{capacity} h capacity</span>
          </div>
        )}
      </div>
    </Tip>
  );
}
