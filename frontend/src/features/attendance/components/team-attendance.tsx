"use client";
import * as React from "react";
import { addMonths } from "date-fns";
import { ChevronLeft, ChevronRight, Clock, LogIn, Palmtree, TriangleAlert, UserX, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tip } from "@/components/ui/overlays";
import { SectionTitle } from "@/components/layout/page-header";
import { DataTable } from "@/components/shared/data-table";
import { EmpChip } from "@/components/shared/emp-chip";
import { StatusBadge } from "@/components/shared/chips";
import { StatCard } from "@/components/shared/metrics";
import { EmptyState, QueryState } from "@/components/shared/states";
import type { BadgeTone } from "@/components/ui/badge";
import { formatMonth, formatTime, isoDay, monthKey } from "@/lib/dates";
import { isWorkingDay } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useHolidayList, useTeamMonth, useTeamToday } from "../hooks";
import { minutesBetween } from "../logic";
import type { TeamTodayRow, TodayState } from "../types";

export const TODAY_STATE: Record<TodayState, { label: string; tone: BadgeTone }> = {
  in: { label: "In", tone: "success" },
  late: { label: "Late", tone: "warning" },
  not_in: { label: "Not in yet", tone: "outline" },
  leave: { label: "On leave", tone: "finance" },
  checked_out: { label: "Checked out", tone: "neutral" },
  off: { label: "Day off", tone: "outline" },
};

/** First login much later than check-in is worth a look (plan §11 "gaps are easy to spot"). */
function LoginGap({ r }: { r: TeamTodayRow }) {
  const gap = minutesBetween(r.checkIn, r.firstLogin);
  if (!r.checkIn) return null;
  if (gap === null) return <span className="text-[11.5px] text-muted-foreground">No login yet</span>;
  const flag = gap > 30;
  return (
    <Tip content="Minutes between check-in and the first login to the system (from activity tracking).">
      <span tabIndex={0} className={cn("inline-flex items-center gap-1 text-[11.5px] outline-none", flag ? "font-medium text-[oklch(0.58_0.14_65)]" : "text-muted-foreground")}>
        {flag && <TriangleAlert className="size-3" />}
        Login {formatTime(r.firstLogin!)} · {gap >= 0 ? "+" : ""}
        {gap} min
      </span>
    </Tip>
  );
}

export function TeamTodayBoard({ compact }: { compact?: boolean }) {
  const q = useTeamToday();
  const holidays = useHolidayList();
  const today = new Date();
  const holiday = holidays.find((h) => h.date === isoDay(today));
  return (
    <QueryState query={q} isEmpty={(d) => d.length === 0} empty={<EmptyState compact icon={<Users />} title="No team to show" description="People who report to you appear here." />}>
      {(rows) => {
        const count = (s: TodayState[]) => rows.filter((r) => s.includes(r.state)).length;
        return (
          <div className="grid gap-4">
            {!compact && (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard label="In" value={count(["in", "checked_out"])} icon={<LogIn />} accent="var(--success)" hint="checked in today" />
                <StatCard label="Late" value={count(["late"])} icon={<Clock />} accent="var(--warning)" hint="after 09:15" />
                <StatCard label="Not in yet" value={count(["not_in"])} icon={<UserX />} accent="var(--muted-foreground)" hint={holiday ? `${holiday.name} today` : "no check-in"} />
                <StatCard label="On leave" value={count(["leave"])} icon={<Palmtree />} accent="var(--zone-finance)" hint="approved leave" />
              </div>
            )}
            {(holiday || !isWorkingDay(today, holidays.map((h) => h.date))) && (
              <p className="rounded-lg border border-signal/60 bg-signal/20 px-3 py-2 text-[12.5px]">
                {holiday ? `Today is ${holiday.name}, a public holiday.` : "Today is a weekend."} Check-ins today are optional and nobody is marked absent.
              </p>
            )}
            <ul className={cn("grid gap-2", !compact && "sm:grid-cols-2 xl:grid-cols-3")}>
              {rows.map((r) => (
                <li key={r.empId} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                  <div className="grid min-w-0 gap-1">
                    <EmpChip empId={r.empId} size="sm" showId={false} />
                    <LoginGap r={r} />
                  </div>
                  <div className="grid shrink-0 justify-items-end gap-1">
                    <StatusBadge {...TODAY_STATE[r.state]} label={r.state === "leave" && r.leaveTypeName ? `${r.leaveTypeName} leave` : r.state === "late" && r.lateMinutes ? `Late ${r.lateMinutes} min` : TODAY_STATE[r.state].label} />
                    {r.checkIn && <span className="font-mono text-[11.5px] text-muted-foreground tabular">{formatTime(r.checkIn)}{r.checkOut ? `–${formatTime(r.checkOut)}` : ""}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      }}
    </QueryState>
  );
}

export function TeamAttendance() {
  const [month, setMonth] = React.useState(() => new Date());
  const q = useTeamMonth(monthKey(month));
  const isCurrent = monthKey(month) === monthKey(new Date());
  return (
    <div className="grid gap-8">
      <section>
        <SectionTitle title="Today" description="Check-in time next to the first login from activity tracking, so gaps are easy to spot." />
        <TeamTodayBoard />
      </section>
      <section>
        <SectionTitle
          title={`Month summary · ${formatMonth(month)}`}
          description={isCurrent ? "Working days so far this month." : undefined}
          actions={
            <div className="flex gap-1">
              <Button size="icon-sm" variant="outline" onClick={() => setMonth((m) => addMonths(m, -1))} aria-label="Previous month">
                <ChevronLeft />
              </Button>
              <Button size="icon-sm" variant="outline" onClick={() => setMonth((m) => addMonths(m, 1))} disabled={isCurrent} aria-label="Next month">
                <ChevronRight />
              </Button>
            </div>
          }
        />
        <DataTable
          rows={q.data}
          loading={q.isPending}
          rowKey={(r) => r.empId}
          empty={<EmptyState compact icon={<Users />} title="No team members" />}
          columns={[
            { key: "person", header: "Person", cell: (r) => <EmpChip empId={r.empId} size="sm" />, sortValue: (r) => r.empId },
            { key: "present", header: "Present", align: "right", cell: (r) => <span className="tabular">{r.present} / {r.workingDays}</span>, sortValue: (r) => r.present },
            { key: "late", header: "Late", align: "right", cell: (r) => <span className={cn("tabular", r.late >= 3 && "font-semibold text-[oklch(0.58_0.14_65)]")}>{r.late}</span>, sortValue: (r) => r.late },
            { key: "leave", header: "Leave", align: "right", cell: (r) => <span className="tabular">{r.leave}</span>, sortValue: (r) => r.leave },
            { key: "absent", header: "Absent", align: "right", cell: (r) => <span className={cn("tabular", r.absent > 0 && "font-semibold text-danger")}>{r.absent}</span>, sortValue: (r) => r.absent },
            { key: "missed", header: "Missed check-out", align: "right", hideOnMobile: true, cell: (r) => <span className="tabular">{r.missedCheckout}</span>, sortValue: (r) => r.missedCheckout },
            { key: "avgIn", header: "Avg check-in", align: "right", cell: (r) => <span className="font-mono tabular">{r.avgCheckIn ?? "—"}</span>, sortValue: (r) => r.avgCheckIn ?? "" },
            {
              key: "gap",
              header: "Avg login gap",
              align: "right",
              hideOnMobile: true,
              cell: (r) => (r.avgLoginGapMin === null ? "—" : <span className={cn("tabular", r.avgLoginGapMin > 15 && "font-semibold text-[oklch(0.58_0.14_65)]")}>{r.avgLoginGapMin} min</span>),
              sortValue: (r) => r.avgLoginGapMin ?? 0,
            },
          ]}
        />
      </section>
    </div>
  );
}

export function TeamTodayCard() {
  return (
    <Card className="p-4">
      <TeamTodayBoard compact />
    </Card>
  );
}
