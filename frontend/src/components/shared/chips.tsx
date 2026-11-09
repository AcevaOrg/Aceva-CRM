"use client";
/** Status badge, deadline chip and freshness stamp. */
import * as React from "react";
import { AlarmClock, CalendarClock, Check, CircleAlert, Clock, RefreshCw, TriangleAlert } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Tip } from "@/components/ui/overlays";
import { dueInfo, formatDateTime, formatRelative } from "@/lib/dates";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

/** A status with text + tone; never colour alone (spec §3.2). */
export function StatusBadge({ label, tone = "neutral", icon, className }: { label: string; tone?: BadgeTone; icon?: React.ReactNode; className?: string }) {
  return (
    <Badge tone={tone} dot={!icon} className={className}>
      {icon}
      {label}
    </Badge>
  );
}

/** Builds a typed status → {label, tone} map helper for modules. */
export function statusMap<T extends string>(map: Record<T, { label: string; tone: BadgeTone }>) {
  return (status: T) => map[status] ?? { label: status, tone: "neutral" as BadgeTone };
}

export function DeadlineChip({ deadline, done, className }: { deadline: string; done?: boolean; className?: string }) {
  const info = dueInfo(deadline);
  if (done)
    return (
      <Badge tone="outline" className={className}>
        <Check /> {formatDateTime(deadline).split(",")[0]}
      </Badge>
    );
  const tone: BadgeTone = { overdue: "danger", today: "warning", soon: "info", later: "outline", done: "outline" }[info.tone] as BadgeTone;
  const Icon = info.tone === "overdue" ? AlarmClock : info.tone === "today" ? Clock : CalendarClock;
  return (
    <Tip content={formatDateTime(deadline)}>
      <span tabIndex={0} className="outline-none">
        <Badge tone={tone} className={cn(info.tone === "overdue" && "font-semibold", className)}>
          <Icon /> {info.label}
        </Badge>
      </span>
    </Tip>
  );
}

/**
 * "Apollo · updated 12 min ago" (spec §3.5.9). Amber after 1 h, red after 3 h.
 */
export function FreshnessStamp({ source, at, className }: { source: string; at?: string; className?: string }) {
  const now = useNow(60_000);
  if (!at)
    return (
      <span className={cn("inline-flex items-center gap-1 text-[11.5px] text-muted-foreground", className)}>
        <CircleAlert className="size-3" /> {source} · never synced
      </span>
    );
  const ageMin = now ? (now - new Date(at).getTime()) / 60_000 : 0;
  const tone = ageMin > 180 ? "text-danger" : ageMin > 60 ? "text-warning" : "text-muted-foreground";
  return (
    <Tip content={ageMin > 180 ? "Numbers may be out of date" : `Last updated ${formatDateTime(at)}`}>
      <span tabIndex={0} className={cn("inline-flex items-center gap-1 text-[11.5px] outline-none", tone, className)}>
        {ageMin > 60 ? <TriangleAlert className="size-3" /> : <RefreshCw className="size-3" />}
        {source} · updated {formatRelative(at)}
      </span>
    </Tip>
  );
}
