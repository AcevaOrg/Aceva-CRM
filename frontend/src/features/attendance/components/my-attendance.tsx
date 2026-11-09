"use client";
import * as React from "react";
import { addMonths } from "date-fns";
import { CalendarCheck, CalendarX2, Clock, LogOut, Palmtree, TimerReset } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MonthCalendar } from "@/components/shared/month-calendar";
import { StatCard } from "@/components/shared/metrics";
import { ErrorState } from "@/components/shared/states";
import { Skeleton } from "@/components/ui/misc";
import { formatTime, isoDay, monthKey } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useMonthAttendance } from "../hooks";
import { averageClock, DAY_STATUS } from "../logic";
import type { AttendanceDay, DayStatus } from "../types";
import { CheckInCard } from "./check-in-card";
import { DaySheet } from "./day-sheet";

const CELL_BG: Partial<Record<DayStatus, string>> = {
  on_time: "bg-success/[0.07]",
  late: "bg-warning/[0.14]",
  missed_checkout: "bg-info/10",
  absent: "bg-danger/10",
  leave: "bg-zone-finance/10",
  holiday: "bg-signal/25",
};

export function StatusLegend({ className }: { className?: string }) {
  const shown: DayStatus[] = ["on_time", "late", "missed_checkout", "absent", "leave", "holiday"];
  return (
    <ul className={cn("flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground", className)} aria-label="Legend">
      {shown.map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ background: DAY_STATUS[s].color }} aria-hidden />
          {DAY_STATUS[s].label}
        </li>
      ))}
    </ul>
  );
}

export function MyAttendance() {
  const [month, setMonth] = React.useState(() => new Date());
  const key = monthKey(month);
  const q = useMonthAttendance(key);
  const [selected, setSelected] = React.useState<AttendanceDay | null>(null);
  const today = isoDay(new Date());

  const days = q.data ?? [];
  const counted = days.filter((d) => !["future", "weekend", "holiday"].includes(d.status));
  const present = counted.filter((d) => ["on_time", "late", "missed_checkout"].includes(d.status)).length;
  const late = counted.filter((d) => d.status === "late").length;
  const leave = counted.filter((d) => d.status === "leave").length;
  const absent = counted.filter((d) => d.status === "absent").length;
  const avgIn = averageClock(counted.filter((d) => d.checkIn).map((d) => d.checkIn!));

  return (
    <div className="grid gap-6">
      <CheckInCard />

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <StatCard label="Days present" value={q.isPending ? "—" : present} hint={`of ${counted.length} working days`} icon={<CalendarCheck />} accent="var(--success)" />
        <StatCard label="Late" value={q.isPending ? "—" : late} hint={`after 09:15`} icon={<TimerReset />} accent="var(--warning)" />
        <StatCard label="On leave" value={q.isPending ? "—" : leave} hint="approved days" icon={<Palmtree />} accent="var(--zone-finance)" />
        <StatCard label="Average check-in" value={q.isPending ? "—" : (avgIn ?? "—")} hint={absent ? `${absent} absent day${absent > 1 ? "s" : ""}` : "no absences"} icon={<Clock />} accent="var(--zone-work)" />
      </div>

      <Card>
        <CardHeader className="flex-wrap">
          <div>
            <CardTitle>My month</CardTitle>
            <p className="text-[13px] text-muted-foreground">Click a past day to see details or ask for a correction.</p>
          </div>
          <StatusLegend />
        </CardHeader>
        <CardContent>
          {q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : q.isPending ? (
            <Skeleton className="h-[520px] w-full rounded-xl" />
          ) : (
            <MonthCalendar
              month={month}
              onMonthChange={(d) => setMonth(monthKey(d) > monthKey(addMonths(new Date(), 2)) ? month : d)}
              minRowHeight={84}
              selected={selected?.date}
              onSelect={(iso) => {
                const d = days.find((x) => x.date === iso);
                if (d && iso <= today && !["weekend", "future"].includes(d.status)) setSelected(d);
                else if (d && iso === today) setSelected(d);
              }}
              dayClassName={(_, iso) => {
                const d = days.find((x) => x.date === iso);
                return d ? CELL_BG[d.status] : undefined;
              }}
              renderDay={(_, iso) => {
                const d = days.find((x) => x.date === iso);
                if (!d || d.status === "future" || d.status === "weekend") return null;
                return (
                  <div className="mt-1 grid gap-0.5">
                    <span className="flex items-center gap-1">
                      <span className="size-1.5 shrink-0 rounded-full" style={{ background: DAY_STATUS[d.status].color }} aria-hidden />
                      <span className="hidden truncate text-[11px] font-medium sm:inline">{d.note && (d.status === "holiday" || d.status === "leave") ? d.note : DAY_STATUS[d.status].label}</span>
                    </span>
                    {d.checkIn && (
                      <span className="hidden font-mono text-[10.5px] text-muted-foreground tabular md:block">
                        {formatTime(d.checkIn)}–{d.checkOut ? formatTime(d.checkOut) : "…"}
                      </span>
                    )}
                    {d.status === "missed_checkout" && <LogOut className="hidden size-3 text-info sm:block" aria-label="Closed automatically" />}
                    {d.status === "absent" && <CalendarX2 className="hidden size-3 text-danger sm:block" aria-hidden />}
                  </div>
                );
              }}
            />
          )}
        </CardContent>
      </Card>

      <DaySheet day={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
