"use client";
import * as React from "react";
import { Moon, TriangleAlert, UserSearch } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { EmployeeSelect } from "@/components/shared/pickers";
import { EmpChip } from "@/components/shared/emp-chip";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { Timeline, type TimelineItem } from "@/components/shared/timeline";
import { useLookup } from "@/hooks/use-directory";
import { useUrlState } from "@/hooks/use-url-state";
import { descendantsOf } from "@/lib/auth/scope";
import { useViewer } from "@/lib/auth/viewer";
import { formatTime, formatWeekdayLong, isoDay } from "@/lib/dates";
import { minutesToHours } from "@/lib/format";
import { useTimeline } from "../hooks";
import type { ActivityEvent, DailySummary } from "../types";
import { ACTION_META, SourceChip } from "./activity-bits";

/** One person, one day, in order (plan §8 "Employee timeline"). */
export function TimelinePanel() {
  const viewer = useViewer();
  const lookup = useLookup();
  const [emp, setEmp] = useUrlState<string>("emp", "");
  const [date, setDate] = useUrlState<string>("date", isoDay(new Date()));
  const query = useTimeline(emp, date);
  if (!viewer) return null;
  const team = new Set(descendantsOf(viewer.employee.empId, lookup.employees));

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Person" htmlFor="tl-emp" className="w-full sm:w-80">
          <EmployeeSelect id="tl-emp" value={emp} onChange={setEmp} filter={(e) => team.has(e.empId)} placeholder="Choose someone in your team" />
        </Field>
        <Field label="Day" htmlFor="tl-date">
          <Input id="tl-date" type="date" value={date} max={isoDay(new Date())} onChange={(e) => setDate(e.target.value || isoDay(new Date()))} />
        </Field>
      </div>

      {!emp ? (
        <EmptyState icon={<UserSearch />} title="Choose a person" description="See their logins, screens, actions and idle time for one day, in order." />
      ) : query.isPending ? (
        <ListSkeleton rows={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          <div className="grid content-start gap-4">
            <Card>
              <CardHeader>
                <div className="min-w-0">
                  <EmpChip empId={emp} />
                  <p className="mt-1 text-[12.5px] text-muted-foreground">{formatWeekdayLong(`${date}T12:00`)}</p>
                </div>
              </CardHeader>
              <CardContent>
                {query.data.summary ? <SummaryBlock s={query.data.summary} /> : <p className="text-[13px] text-muted-foreground">No activity on this day.</p>}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              {query.data.events === null ? (
                <p className="rounded-lg bg-muted px-3 py-3 text-[13px] text-muted-foreground">You see the daily summary. The full timeline of screens and actions is visible to the managers above this person (CTO, Director) and the CEO / Founder / Owner.</p>
              ) : query.data.events.length === 0 ? (
                <EmptyState compact title="No events" description="Nothing was recorded for this person on this day." />
              ) : (
                <Timeline items={buildItems(query.data.events, query.data.summary)} />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

/** Day summary + the check-in vs first-login comparison (plan §11 link with tracking). */
export function SummaryBlock({ s }: { s: DailySummary }) {
  const gap = s.checkIn && s.firstLogin ? Math.round((new Date(s.firstLogin).getTime() - new Date(s.checkIn).getTime()) / 60_000) : 0;
  return (
    <div className="grid gap-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
        {[
          ["Check-in", s.checkIn ? formatTime(s.checkIn) : "—"],
          ["First login", s.firstLogin ? formatTime(s.firstLogin) : "—"],
          ["Last logout", s.lastLogout ? formatTime(s.lastLogout) : "Still signed in"],
          ["Actions", String(s.actions)],
          ["Active", minutesToHours(s.activeMinutes)],
          ["Idle", minutesToHours(s.idleMinutes)],
          ["Tasks touched", String(s.tasksTouched)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">{k}</dt>
            <dd className="font-mono tabular">{v}</dd>
          </div>
        ))}
      </dl>
      <DayStrip s={s} />
      {gap > 30 && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/12 px-3 py-2 text-[12.5px]">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[oklch(0.6_0.14_70)]" />
          Checked in at {formatTime(s.checkIn!)} but first logged in at {formatTime(s.firstLogin!)}: a gap of {minutesToHours(gap)}.
        </p>
      )}
    </div>
  );
}

/** 08:00–20:00 strip: signed-in time in the zone colour, idle spans hatched. */
function DayStrip({ s }: { s: DailySummary }) {
  const [now] = React.useState(() => Date.now());
  if (!s.firstLogin) return null;
  const day = new Date(s.firstLogin);
  const start = new Date(day).setHours(8, 0, 0, 0);
  const end = new Date(day).setHours(20, 0, 0, 0);
  const span = end - start;
  const pos = (t: number) => Math.max(0, Math.min(100, ((t - start) / span) * 100));
  const from = new Date(s.firstLogin).getTime();
  const to = s.lastLogout ? new Date(s.lastLogout).getTime() : Math.min(now, end);
  return (
    <div>
      <div className="relative h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label={`Signed in ${formatTime(from)} to ${s.lastLogout ? formatTime(to) : "now"}`}>
        <span className="absolute inset-y-0 bg-zone-control" style={{ left: `${pos(from)}%`, width: `${pos(to) - pos(from)}%` }} />
        {s.idleSpans?.map((i, k) => (
          <span
            key={k}
            className="absolute inset-y-0 bg-warning/80"
            style={{
              left: `${pos(new Date(i.from).getTime())}%`,
              width: `${pos(new Date(i.to).getTime()) - pos(new Date(i.from).getTime())}%`,
              backgroundImage: "repeating-linear-gradient(45deg, transparent 0 3px, oklch(1 0 0 / 0.4) 3px 6px)",
            }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-muted-foreground tabular">
        <span>08:00</span>
        <span>12:00</span>
        <span>16:00</span>
        <span>20:00</span>
      </div>
      <p className="mt-1 flex items-center gap-3 text-[11.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-zone-control" /> Signed in</span>
        <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-warning" /> Idle</span>
      </p>
    </div>
  );
}

export function eventItem(e: ActivityEvent): TimelineItem {
  const m = ACTION_META[e.action];
  const Icon = m.icon;
  return {
    id: e.id,
    icon: <Icon />,
    color: m.color,
    title: e.description,
    meta: (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {m.label}{e.module !== m.label ? ` · ${e.module}` : ""}
        {e.source !== "aceva" && <SourceChip source={e.source} />}
        {e.city && <span>· {e.city}</span>}
        {e.device && <span>· {e.device}</span>}
      </span>
    ),
    body: e.changes?.length ? (
      <span className="flex flex-wrap gap-2">
        {e.changes.map((c) => (
          <span key={c.field} className="rounded-md bg-muted px-2 py-1 font-mono text-[11.5px]">
            {c.field}: <span className="text-muted-foreground line-through">{c.from}</span> → {c.to}
          </span>
        ))}
      </span>
    ) : undefined,
    time: formatTime(e.at),
  };
}

function buildItems(events: ActivityEvent[], s?: DailySummary): TimelineItem[] {
  const idle: (TimelineItem & { at: string })[] = (s?.idleSpans ?? []).map((i, k) => ({
    id: `idle_${k}`,
    at: i.from,
    icon: <Moon />,
    color: "var(--warning)",
    title: `Idle ${minutesToHours(Math.round((new Date(i.to).getTime() - new Date(i.from).getTime()) / 60_000))}`,
    meta: `${formatTime(i.from)} to ${formatTime(i.to)} · no mouse or keyboard`,
    time: formatTime(i.from),
    muted: true,
  }));
  return [...events.map((e) => ({ ...eventItem(e), at: e.at })), ...idle].sort((a, b) => a.at.localeCompare(b.at));
}
