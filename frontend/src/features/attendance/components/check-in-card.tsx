"use client";
/**
 * Big check-in card (spec §9.7). Shares state with the topbar pill through the session store.
 * Exported for the Home dashboard: <CheckInCard /> or <CheckInCard compact />.
 */
import * as React from "react";
import { toast } from "sonner";
import { CalendarHeart, Clock, LogIn, LogOut, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useTodayCheck, WORK_START } from "@/components/layout/topbar-widgets";
import { useSession } from "@/lib/auth/session";
import { formatTime, formatWeekdayLong, isoDay } from "@/lib/dates";
import { minutesToHours } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HOLIDAYS } from "@/mocks/seed/calendar";
import { useRefreshAttendance } from "../hooks";
import { graceEndLabel, lateMinutes } from "../logic";

function useClock() {
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    // Start on the client only (avoids a server/client time mismatch), then tick every second.
    const first = setTimeout(() => setNow(new Date()), 0);
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  return now;
}

/** Ring that fills through the grace window: start → start + grace. */
function GraceRing({ now, checkedIn, optional }: { now: Date; checkedIn: boolean; optional?: boolean }) {
  const start = new Date(now);
  start.setHours(WORK_START.hour, WORK_START.minute, 0, 0);
  const graceEnd = new Date(start.getTime() + WORK_START.graceMin * 60_000);
  const before = now < start;
  const late = now > graceEnd;
  const pct = before ? 0 : late ? 1 : (now.getTime() - start.getTime()) / (graceEnd.getTime() - start.getTime());
  const minsLeft = Math.max(0, Math.ceil((graceEnd.getTime() - now.getTime()) / 60_000));
  const size = 88;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = checkedIn ? "var(--success)" : optional ? "var(--signal)" : late ? "var(--warning)" : "var(--zone-work)";
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-hidden>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={`${c * (checkedIn ? 1 : pct)} ${c}`} strokeLinecap="round" className="transition-[stroke-dasharray] duration-700" />
      </svg>
      <div className="absolute grid place-items-center text-center leading-none">
        {checkedIn ? (
          <ShieldCheck className="size-6 text-success" />
        ) : optional ? (
          <>
            <span className="text-[14px] font-semibold">Day off</span>
            <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">optional</span>
          </>
        ) : before ? (
          <>
            <span className="font-mono text-[15px] font-semibold tabular">{graceEndLabel()}</span>
            <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">on time</span>
          </>
        ) : late ? (
          <>
            <span className="text-[15px] font-semibold">Late</span>
            <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">after {graceEndLabel()}</span>
          </>
        ) : (
          <>
            <span className="font-mono text-[18px] font-semibold tabular">{minsLeft}</span>
            <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">min left</span>
          </>
        )}
      </div>
    </div>
  );
}

export function CheckInCard({ compact, className }: { compact?: boolean; className?: string }) {
  const now = useClock();
  const check = useTodayCheck();
  const checkIn = useSession((s) => s.checkIn);
  const checkOut = useSession((s) => s.checkOut);
  const refresh = useRefreshAttendance();

  if (!now) return <Card className={cn("h-[132px] animate-pulse", className)} />;

  const holiday = HOLIDAYS.find((h) => h.date === isoDay(now));
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  const lm = check?.in ? lateMinutes(check.in) : 0;
  const elapsedMin = check?.in ? Math.round(((check.out ? new Date(check.out).getTime() : now.getTime()) - new Date(check.in).getTime()) / 60_000) : 0;

  const doCheckIn = () => {
    checkIn();
    const late = lateMinutes(new Date());
    toast.success(`Checked in at ${formatTime(new Date())}`, { description: late ? `${late} min after ${graceEndLabel()}. It is marked late.` : "On time. Time comes from the server clock." });
    refresh();
  };
  const doCheckOut = () => {
    checkOut();
    toast.success(`Checked out at ${formatTime(new Date())}`, { description: `Time at work today: ${minutesToHours(elapsedMin)}.` });
    refresh();
  };

  return (
    <Card className={cn("layer-lines relative overflow-hidden", className)} style={{ ["--layer-color" as string]: "var(--zone-work)" }}>
      <div className={cn("relative flex flex-wrap items-center gap-5 bg-gradient-to-r from-card via-card/95 to-card/70 p-5", compact && "gap-4 p-4")}>
        <GraceRing now={now} checkedIn={!!check?.in} optional={!!holiday || weekend} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zone-work">Today</p>
          <p className="mt-0.5 text-[17px] font-semibold tracking-tight">{formatWeekdayLong(now)}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Clock className="size-3.5" /> Server time <span className="font-mono font-medium text-foreground tabular">{now.toLocaleTimeString("en-GB", { hour12: false })}</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {holiday && (
              <Badge tone="signal">
                <CalendarHeart /> {holiday.name} · public holiday, check-in is optional
              </Badge>
            )}
            {!holiday && weekend && <Badge tone="outline">Weekend · check-in is optional</Badge>}
            {check?.in && (
              <Badge tone={lm ? "warning" : "success"} dot>
                In at {formatTime(check.in)} · {lm ? `late by ${lm} min` : "on time"}
              </Badge>
            )}
            {check?.out && <Badge tone="outline">Out at {formatTime(check.out)}</Badge>}
          </div>
        </div>
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
          {!check?.in ? (
            <>
              <Button size="lg" variant="signal" onClick={doCheckIn} className="h-12 px-6 text-[15px]">
                <LogIn /> Check in
              </Button>
              <p className="text-center text-[11.5px] text-muted-foreground sm:text-right">{holiday || weekend ? "Not required today" : `On time until ${graceEndLabel()}`}</p>
            </>
          ) : !check.out ? (
            <>
              <div className="flex items-center justify-center gap-2 sm:justify-end">
                <span className="size-2.5 rounded-full bg-signal animate-pulse-signal" aria-hidden />
                <span className="font-mono text-[24px] font-semibold tabular leading-none">{minutesToHours(elapsedMin)}</span>
              </div>
              <Button variant="outline" onClick={doCheckOut}>
                <LogOut /> Check out
              </Button>
            </>
          ) : (
            <div className="text-center sm:text-right">
              <p className="text-[11.5px] uppercase tracking-wider text-muted-foreground">Day complete</p>
              <p className="font-mono text-[24px] font-semibold tabular leading-tight">{minutesToHours(elapsedMin)}</p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
