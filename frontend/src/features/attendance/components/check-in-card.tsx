"use client";
/**
 * Big check-in card (spec §9.7). Shares state with the topbar pill (mock: the session store; live m7: GET /attendance/today).
 * Exported for the Home dashboard: <CheckInCard /> or <CheckInCard compact />.
 * Live: the time, lateness, schedule, holiday and office-network rule all come from the server; the card only shows them.
 */
import * as React from "react";
import { toast } from "sonner";
import { CalendarHeart, Clock, LogIn, LogOut, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useTodayCheck, WORK_START } from "@/components/layout/topbar-widgets";
import { isLive } from "@/lib/api/http";
import { useSession } from "@/lib/auth/session";
import { formatTime, formatWeekdayLong, isoDay } from "@/lib/dates";
import { minutesToHours } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HOLIDAYS } from "@/mocks/seed/calendar";
import { useRefreshAttendance } from "../hooks";
import { graceEndLabel, lateMinutes } from "../logic";
import { useLiveCheck, useLiveToday } from "../today";

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

interface RingSchedule {
  startMinute: number;
  graceMinutes: number;
  graceEnd: string;
}

const MOCK_RING: RingSchedule = { startMinute: WORK_START.hour * 60 + WORK_START.minute, graceMinutes: WORK_START.graceMin, graceEnd: graceEndLabel() };

/** Minutes after midnight in Pakistan (live mode: the schedule is in Pakistan time, UTC+5). */
function pkMinutes(d: Date) {
  const x = new Date(d.getTime() + 5 * 3600_000);
  return x.getUTCHours() * 60 + x.getUTCMinutes() + x.getUTCSeconds() / 60;
}

/** Ring that fills through the grace window: start → start + grace (a check-in in the grace-end minute is still on time). */
function GraceRing({ now, checkedIn, optional, schedule = MOCK_RING, pakistan }: { now: Date; checkedIn: boolean; optional?: boolean; schedule?: RingSchedule; pakistan?: boolean }) {
  const minute = pakistan ? pkMinutes(now) : now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const graceEndMinute = schedule.startMinute + schedule.graceMinutes;
  const before = minute < schedule.startMinute;
  const late = minute >= graceEndMinute + 1;
  const pct = before ? 0 : late ? 1 : schedule.graceMinutes ? Math.min(1, (minute - schedule.startMinute) / schedule.graceMinutes) : 1;
  const minsLeft = Math.max(0, Math.ceil(graceEndMinute + 1 - minute));
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
            <span className="font-mono text-[15px] font-semibold tabular">{schedule.graceEnd}</span>
            <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">on time</span>
          </>
        ) : late ? (
          <>
            <span className="text-[15px] font-semibold">Late</span>
            <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">after {schedule.graceEnd}</span>
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
  const browserNow = useClock();
  const check = useTodayCheck();
  const mockCheckIn = useSession((s) => s.checkIn);
  const mockCheckOut = useSession((s) => s.checkOut);
  const refresh = useRefreshAttendance();
  const live = isLive("m7");
  const today = useLiveToday();
  const liveCheck = useLiveCheck();
  const server = today.data;

  if (!browserNow || (live && !server)) return <Card className={cn("h-[132px] animate-pulse", className)} />;

  // Live: show the SERVER time (the offset is measured when today's record was fetched).
  const offset = live && server ? Date.parse(server.serverTime) - today.dataUpdatedAt : 0;
  const now = new Date(browserNow.getTime() + offset);
  const ring: RingSchedule | undefined =
    live && server?.schedule
      ? { startMinute: Number(server.schedule.start.slice(0, 2)) * 60 + Number(server.schedule.start.slice(3)), graceMinutes: server.schedule.graceMinutes, graceEnd: server.schedule.graceEnd }
      : undefined;
  const graceEnd = ring?.graceEnd ?? graceEndLabel();
  const holiday = live ? (server?.holiday ? { name: server.holiday } : undefined) : HOLIDAYS.find((h) => h.date === isoDay(now));
  const weekend = live ? !!server && !server.workingDay && !server.holiday : now.getDay() === 0 || now.getDay() === 6;
  const lm = live ? (server?.lateMinutes ?? 0) : check?.in ? lateMinutes(check.in) : 0;
  const elapsedMin = check?.in ? Math.round(((check.out ? new Date(check.out).getTime() : now.getTime()) - new Date(check.in).getTime()) / 60_000) : 0;
  const officeBlocked = live && !!server && !server.checkInAllowedHere && !check?.in;
  const clockText = live
    ? new Date(now.getTime() + 5 * 3600_000).toISOString().slice(11, 19)
    : now.toLocaleTimeString("en-GB", { hour12: false });

  const doCheckIn = async () => {
    if (live) {
      try {
        const res = await liveCheck.checkIn.mutateAsync();
        toast.success(`Checked in at ${formatTime(res.checkIn!)}`, { description: res.lateMinutes ? `${res.lateMinutes} min after ${graceEnd}. It is marked late.` : "On time. Time comes from the server clock." });
      } catch (e) {
        toast.error((e as Error).message);
      }
      return;
    }
    mockCheckIn();
    const late = lateMinutes(new Date());
    toast.success(`Checked in at ${formatTime(new Date())}`, { description: late ? `${late} min after ${graceEndLabel()}. It is marked late.` : "On time. Time comes from the server clock." });
    refresh();
  };
  const doCheckOut = async () => {
    if (live) {
      try {
        const res = await liveCheck.checkOut.mutateAsync();
        toast.success(`Checked out at ${formatTime(res.checkOut!)}`, { description: `Time at work today: ${minutesToHours(elapsedMin)}.` });
      } catch (e) {
        toast.error((e as Error).message);
      }
      return;
    }
    mockCheckOut();
    toast.success(`Checked out at ${formatTime(new Date())}`, { description: `Time at work today: ${minutesToHours(elapsedMin)}.` });
    refresh();
  };

  return (
    <Card className={cn("layer-lines relative overflow-hidden", className)} style={{ ["--layer-color" as string]: "var(--zone-work)" }}>
      <div className={cn("relative flex flex-wrap items-center gap-5 bg-gradient-to-r from-card via-card/95 to-card/70 p-5", compact && "gap-4 p-4")}>
        <GraceRing now={now} checkedIn={!!check?.in} optional={!!holiday || weekend} schedule={ring} pakistan={live} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zone-work">Today</p>
          <p className="mt-0.5 text-[17px] font-semibold tracking-tight">{formatWeekdayLong(now)}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Clock className="size-3.5" /> Server time <span className="font-mono font-medium text-foreground tabular">{clockText}</span>
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
            {live && server?.missedCheckout && <Badge tone="info">Missed check-out · closed by the system</Badge>}
            {live && server?.leave && !check?.in && <Badge tone="finance">On leave · {server.leave}</Badge>}
            {officeBlocked && <Badge tone="warning">Check-in is only allowed from the office network.</Badge>}
          </div>
        </div>
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
          {!check?.in ? (
            <>
              <Button size="lg" variant="signal" onClick={() => void doCheckIn()} loading={liveCheck.checkIn.isPending} disabled={officeBlocked} className="h-12 px-6 text-[15px]">
                <LogIn /> Check in
              </Button>
              <p className="text-center text-[11.5px] text-muted-foreground sm:text-right">{holiday || weekend ? "Not required today" : `On time until ${graceEnd}`}</p>
            </>
          ) : !check.out ? (
            <>
              <div className="flex items-center justify-center gap-2 sm:justify-end">
                <span className="size-2.5 rounded-full bg-signal animate-pulse-signal" aria-hidden />
                <span className="font-mono text-[24px] font-semibold tabular leading-none">{minutesToHours(elapsedMin)}</span>
              </div>
              <Button variant="outline" onClick={() => void doCheckOut()} loading={liveCheck.checkOut.isPending}>
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
