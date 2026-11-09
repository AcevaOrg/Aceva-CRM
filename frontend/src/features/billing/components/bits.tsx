"use client";
/** Small billing display pieces: status badges, countdown, sparkline. */
import { Badge } from "@/components/ui/badge";
import { Tip } from "@/components/ui/overlays";
import { StatusBadge } from "@/components/shared/chips";
import { formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { daysUntil, INVOICE_STATUS, INVOICE_TYPE, PERIOD_LABEL, SUB_STATUS } from "../logic";
import type { Invoice, InvoiceStatus, SubscriptionStatus } from "../types";

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const s = INVOICE_STATUS[status];
  return <StatusBadge label={s.label} tone={s.tone} />;
}

export function InvoiceTypeLabel({ invoice }: { invoice: Pick<Invoice, "type" | "period"> }) {
  return (
    <span className="text-[12.5px] text-muted-foreground">
      {INVOICE_TYPE[invoice.type]}
      {invoice.period && invoice.type !== "one_time" ? ` · ${PERIOD_LABEL[invoice.period].toLowerCase()}` : ""}
    </span>
  );
}

export function SubStatusBadge({ status }: { status: SubscriptionStatus }) {
  const s = SUB_STATUS[status];
  return <StatusBadge label={s.label} tone={s.tone} />;
}

/** "in 6 days" chip coloured by how close the date is. */
export function Countdown({ date, alertDays = 7, past = "ago" }: { date: string; alertDays?: number; past?: string }) {
  const d = daysUntil(date);
  const tone = d < 0 ? "neutral" : d <= Math.min(3, alertDays) ? "danger" : d <= alertDays ? "warning" : "outline";
  const label = d === 0 ? "Today" : d === 1 ? "Tomorrow" : d > 0 ? `In ${d} days` : `${-d} days ${past}`;
  return (
    <Tip content={formatDate(date)}>
      <span tabIndex={0} className="outline-none">
        <Badge tone={tone}>{label}</Badge>
      </span>
    </Tip>
  );
}

/** Tiny inline trend line (usage readings). */
export function Sparkline({ values, className, color = "var(--zone-finance)" }: { values: number[]; className?: string; color?: string }) {
  if (values.length < 2) return null;
  const w = 96;
  const h = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 3 - ((v - min) / span) * (h - 6)}`).join(" ");
  const last = pts.split(" ").pop()!.split(",");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cn("overflow-visible", className)} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={color} />
    </svg>
  );
}
