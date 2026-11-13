"use client";
import * as React from "react";
import Link from "next/link";
import { CalendarDays, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { Tip } from "@/components/ui/overlays";
import { EmpChip } from "@/components/shared/emp-chip";
import { MonthCalendar } from "@/components/shared/month-calendar";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { formatDate, isoDay, monthKey } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useHolidayList, useLeaveCalendar, useLeaveTypes } from "../hooks";
import { isPendingLeave } from "../logic";
import { leaveDates } from "./leave-request-card";

export function LeaveCalendar() {
  const [month, setMonth] = React.useState(() => new Date());
  const q = useLeaveCalendar(monthKey(month));
  const holidays = useHolidayList();
  const types = useLeaveTypes();
  const lookup = useLookup();
  const color = (id: string) => types.data?.find((t) => t.id === id)?.color ?? "var(--muted-foreground)";
  const entries = q.data ?? [];
  const withClashes = entries.filter((e) => e.deadlineClashes.length);

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader className="flex-wrap">
          <div>
            <CardTitle>Who&apos;s away</CardTitle>
            <p className="text-[13px] text-muted-foreground">Approved leave is solid; waiting requests are faded. A warning marks task deadlines during leave.</p>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
            {(types.data ?? []).map((t) => (
              <li key={t.id} className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full" style={{ background: t.color }} /> {t.name}
              </li>
            ))}
            {entries.some((e) => !e.leaveTypeId) && (
              <li className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-muted-foreground" /> Away (your team)
              </li>
            )}
          </ul>
        </CardHeader>
        <CardContent>
          {q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : q.isPending ? (
            <Skeleton className="h-[520px] w-full rounded-xl" />
          ) : (
            <MonthCalendar
              month={month}
              onMonthChange={setMonth}
              minRowHeight={96}
              dayClassName={(_, iso) => (holidays.some((h) => h.date === iso) ? "bg-signal/20" : undefined)}
              renderDay={(d, iso) => {
                const holiday = holidays.find((h) => h.date === iso);
                if (d.getDay() === 0 || d.getDay() === 6) return null;
                const on = entries.filter((e) => e.from <= iso && e.to >= iso);
                return (
                  <div className="mt-1 grid gap-0.5">
                    {holiday && <span className="hidden truncate text-[10.5px] font-medium sm:block">{holiday.name}</span>}
                    {!holiday &&
                      on.slice(0, 3).map((e) => {
                        const emp = lookup.employee(e.empId);
                        const clash = e.deadlineClashes.find((c) => isoDay(c.deadline) === iso);
                        return (
                          <Tip key={e.requestId} content={`${emp?.name ?? e.empId} · ${isPendingLeave(e.status) ? "waiting for approval" : "approved"}${clash ? ` · ${clash.number} is due this day` : ""}`}>
                            <span
                              tabIndex={0}
                              className={cn(
                                "flex min-w-0 items-center gap-1 rounded px-1 py-px text-[10.5px] font-medium outline-none",
                                isPendingLeave(e.status) ? "border border-dashed opacity-70" : "",
                              )}
                              style={{ background: `color-mix(in oklch, ${color(e.leaveTypeId)} 18%, transparent)`, borderColor: color(e.leaveTypeId) }}
                            >
                              {clash && <TriangleAlert className="size-2.5 shrink-0 text-[oklch(0.58_0.15_60)]" />}
                              <span className="truncate">{emp?.name.split(" ")[0] ?? e.empId}</span>
                            </span>
                          </Tip>
                        );
                      })}
                    {!holiday && on.length > 3 && <span className="text-[10px] text-muted-foreground">+{on.length - 3} more</span>}
                  </div>
                );
              }}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Deadline warnings</CardTitle>
            <p className="text-[13px] text-muted-foreground">Task deadlines that fall while the person is away.</p>
          </div>
        </CardHeader>
        <CardContent>
          {!withClashes.length ? (
            <EmptyState compact icon={<CalendarDays />} title="No clashes this month" description="No task deadline falls during anyone's leave." />
          ) : (
            <ul className="grid gap-3">
              {withClashes.map((e) => (
                <li key={e.requestId} className="grid gap-2 rounded-xl border border-warning/35 bg-warning/8 p-3 sm:grid-cols-[minmax(0,220px)_1fr]">
                  <div className="grid gap-1">
                    <EmpChip empId={e.empId} size="sm" />
                    <span className="text-[12px] text-muted-foreground">
                      {leaveDates(e)} · {isPendingLeave(e.status) ? "waiting" : "approved"}
                    </span>
                  </div>
                  <ul className="grid gap-1 text-[12.5px]">
                    {e.deadlineClashes.map((c) => (
                      <li key={c.taskId} className="flex flex-wrap items-center gap-2">
                        <TriangleAlert className="size-3.5 text-[oklch(0.6_0.14_70)]" />
                        <Link href={`/tasks/${c.taskId}`} className="font-mono text-primary hover:underline">
                          {c.number}
                        </Link>
                        <span className="min-w-0 truncate">{c.title}</span>
                        <span className="text-muted-foreground">due {formatDate(c.deadline)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
