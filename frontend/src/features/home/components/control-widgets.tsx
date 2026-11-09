"use client";
/** Home widgets from Activity tracking (M4). */
import Link from "next/link";
import { Radio, ShieldAlert } from "lucide-react";
import { StatusBadge } from "@/components/shared/chips";
import { EmpChip } from "@/components/shared/emp-chip";
import { useOnlineNow, useSecurityAlerts } from "@/features/activity/hooks";
import { formatRelative } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { Widget, WidgetEmpty, WidgetSkeleton } from "./widget";

export function SecurityAlertsWidget() {
  const q = useSecurityAlerts("open");
  const alerts = q.data ?? [];
  return (
    <Widget title="Security alerts" icon={<ShieldAlert />} href="/activity?tab=alerts" linkLabel={alerts.length ? `All ${alerts.length}` : "Open"}>
      {q.isPending ? (
        <WidgetSkeleton />
      ) : alerts.length ? (
        <ul className="-mx-2 grid">
          {alerts.slice(0, 4).map((a) => (
            <li key={a.id}>
              <Link href="/activity?tab=alerts" className="flex items-start gap-3 rounded-lg px-2 py-2 transition hover:bg-muted">
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", a.severity === "high" ? "bg-danger" : a.severity === "medium" ? "bg-warning" : "bg-info")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{a.rule}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">{a.details}</span>
                </span>
                <span className="shrink-0 text-[11.5px] text-muted-foreground">{formatRelative(a.at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <WidgetEmpty>No open alerts.</WidgetEmpty>
      )}
    </Widget>
  );
}

export function OnlineNowWidget() {
  const q = useOnlineNow();
  const rows = q.data ?? [];
  const active = rows.filter((r) => r.state === "active").length;
  return (
    <Widget
      title="Who's online"
      icon={<Radio />}
      href="/activity?tab=online"
      action={!q.isPending && <StatusBadge label={`${active} active · ${rows.length - active} idle`} tone="signal" />}
    >
      {q.isPending ? (
        <WidgetSkeleton />
      ) : rows.length ? (
        <ul className="grid gap-2">
          {rows.slice(0, 6).map((r) => (
            <li key={r.sessionId} className="flex items-center justify-between gap-3">
              <EmpChip empId={r.empId} size="sm" subtitle={r.currentScreen} />
              <span className={cn("inline-flex items-center gap-1.5 text-[12px]", r.state === "active" ? "text-foreground" : "text-muted-foreground")}>
                <span className={cn("size-2 rounded-full", r.state === "active" ? "bg-signal animate-pulse-signal" : "bg-muted-foreground/50")} />
                {r.state === "active" ? "Active" : "Idle"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <WidgetEmpty>Nobody in your scope is online.</WidgetEmpty>
      )}
    </Widget>
  );
}
