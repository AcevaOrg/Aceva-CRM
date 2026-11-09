"use client";
import * as React from "react";
import { addMonths, endOfMonth, endOfWeek, isSameMonth, isToday, startOfMonth, startOfWeek, addDays } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMonth, isoDay } from "@/lib/dates";
import { cn } from "@/lib/utils";

/**
 * Month grid (Mon–Sun). Today is marked in signal citron (spec §3.1).
 * renderDay returns the cell content; onSelect gets the ISO day.
 */
export function MonthCalendar({
  month,
  onMonthChange,
  renderDay,
  onSelect,
  selected,
  dayClassName,
  className,
  minRowHeight = 92,
}: {
  month: Date;
  onMonthChange?: (d: Date) => void;
  renderDay?: (day: Date, iso: string) => React.ReactNode;
  onSelect?: (iso: string) => void;
  selected?: string;
  dayClassName?: (day: Date, iso: string) => string | undefined;
  className?: string;
  minRowHeight?: number;
}) {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  const days: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-card shadow-strata", className)}>
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <p className="font-semibold">{formatMonth(month)}</p>
        {onMonthChange && (
          <div className="flex gap-1">
            <Button size="icon-sm" variant="ghost" onClick={() => onMonthChange(addMonths(month, -1))} aria-label="Previous month">
              <ChevronLeft />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onMonthChange(new Date())}>
              Today
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => onMonthChange(addMonths(month, 1))} aria-label="Next month">
              <ChevronRight />
            </Button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-7 border-b border-border bg-muted/40 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="py-1.5">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const iso = isoDay(d);
          const inMonth = isSameMonth(d, month);
          const weekend = d.getDay() === 0 || d.getDay() === 6;
          return (
            <div
              key={iso}
              role={onSelect ? "button" : undefined}
              tabIndex={onSelect ? 0 : undefined}
              onClick={onSelect ? () => onSelect(iso) : undefined}
              onKeyDown={onSelect ? (e) => (e.key === "Enter" || e.key === " ") && onSelect(iso) : undefined}
              className={cn(
                "relative border-b border-r border-border p-1.5 text-left text-[12px] last:border-r-0 [&:nth-child(7n)]:border-r-0",
                !inMonth && "bg-muted/30 text-muted-foreground/60",
                weekend && inMonth && "bg-muted/20",
                onSelect && "cursor-pointer hover:bg-accent/60",
                selected === iso && "outline-2 -outline-offset-2 outline-primary",
                dayClassName?.(d, iso),
              )}
              style={{ minHeight: minRowHeight }}
            >
              <span
                className={cn(
                  "inline-grid size-6 place-content-center rounded-full text-[12px] font-medium tabular",
                  isToday(d) && "bg-signal font-semibold text-signal-foreground",
                )}
              >
                {d.getDate()}
              </span>
              {inMonth && renderDay?.(d, iso)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
