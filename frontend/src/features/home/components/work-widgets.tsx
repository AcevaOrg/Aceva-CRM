"use client";
/** Home widgets from Attendance & leave (M7) and Performance (M6). */
import { CalendarDays, Gauge } from "lucide-react";
import { Progress } from "@/components/ui/misc";
import { ScoreDial } from "@/components/shared/metrics";
import { useLeaveBalances } from "@/features/attendance/hooks";
import { useLatestScorecard, useLivePerformance } from "@/features/performance/hooks";
import { formatMonthKey } from "@/lib/dates";
import { Widget, WidgetEmpty, WidgetSkeleton } from "./widget";

export { CheckInCard } from "@/features/attendance/components/check-in-card";
export { TeamTodayCard } from "@/features/attendance/components/team-attendance";

export function LeaveBalanceWidget() {
  const q = useLeaveBalances();
  return (
    <Widget title="My leave" icon={<CalendarDays />} href="/leave" linkLabel="Request leave" seal="own">
      {q.isPending ? (
        <WidgetSkeleton rows={3} />
      ) : !q.data?.length ? (
        <WidgetEmpty>No leave types set up yet.</WidgetEmpty>
      ) : (
        <ul className="grid gap-3">
          {q.data.map((b) => (
            <li key={b.leaveTypeId} className="grid gap-1">
              <div className="flex items-center justify-between text-[13px]">
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{ background: b.leaveType.color }} />
                  {b.leaveType.name}
                </span>
                <span className="text-muted-foreground tabular">
                  {b.remaining === null ? `${b.used} used` : `${b.remaining} of ${b.total} left`}
                  {b.pending > 0 && ` · ${b.pending} pending`}
                </span>
              </div>
              {b.remaining !== null && <Progress value={b.used + b.pending} max={b.total || 1} barClassName="bg-zone-work" />}
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}

export function PerformanceWidget() {
  const live = useLivePerformance();
  const latest = useLatestScorecard();
  const p = live.data;
  return (
    <Widget title="My performance" icon={<Gauge />} href={latest.data ? `/performance/scorecards/${latest.data.id}` : "/performance"} linkLabel={latest.data ? "Latest scorecard" : "Details"} seal="own">
      {live.isPending ? (
        <WidgetSkeleton rows={3} />
      ) : !p ? (
        <WidgetEmpty>No figures yet this month.</WidgetEmpty>
      ) : (
        <div className="flex items-center gap-5">
          <ScoreDial score={p.score} size={124} />
          <div className="grid gap-1 text-[13px]">
            <p className="font-medium">{formatMonthKey(p.month)} so far</p>
            <p className="text-muted-foreground">
              {p.taskCount} scored task{p.taskCount === 1 ? "" : "s"}
              {p.smallSample && " · small sample, one task can swing it"}
            </p>
            {latest.data && (
              <p className="text-muted-foreground">
                Last scorecard ({formatMonthKey(latest.data.month)}): <span className="font-semibold text-foreground tabular">{Math.round(latest.data.score)}</span>
              </p>
            )}
          </div>
        </div>
      )}
    </Widget>
  );
}
