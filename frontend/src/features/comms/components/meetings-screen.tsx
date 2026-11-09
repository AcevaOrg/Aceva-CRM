"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { addDays, addWeeks, isSameDay, isToday, startOfWeek } from "date-fns";
import { CalendarClock, ChevronLeft, ChevronRight, List, ListTodo, MapPin, Paperclip, Plus, Rows3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/controls";
import { PageHeader } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { AvatarStack } from "@/components/shared/emp-chip";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { useViewer } from "@/lib/auth/viewer";
import { formatDateShort, formatWeekday } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useMeetings } from "../hooks";
import { dayLabel } from "../logic";
import type { Meeting } from "../types";
import { isPast, RsvpBadge, RsvpControl, timeRange } from "./meeting-bits";
import { NewMeetingSheet } from "./new-meeting-sheet";

type View = "list" | "week";

export function MeetingsScreen() {
  const [view, setView] = useUrlState<View>("view", "list");
  const [creating, setCreating] = React.useState(false);
  const q = useMeetings();

  return (
    <RequireAccess permission="comms.use">
      <PageHeader
        title="Meetings"
        description="Meetings you organise or are invited to, with agenda, notes and files in one place."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New meeting
          </Button>
        }
      />
      <div className="mb-4 flex items-center justify-between gap-3">
        <SegmentedControl
          value={view}
          onChange={setView}
          ariaLabel="View"
          options={[
            { value: "list", label: <><List /> List</> },
            { value: "week", label: <><Rows3 /> Week</> },
          ]}
        />
      </div>
      {q.isPending ? (
        <ListSkeleton rows={5} className="[&>*]:h-20" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : view === "list" ? (
        <MeetingList meetings={q.data} onNew={() => setCreating(true)} />
      ) : (
        <WeekView meetings={q.data} />
      )}
      <NewMeetingSheet open={creating} onOpenChange={setCreating} />
    </RequireAccess>
  );
}

function MeetingList({ meetings, onNew }: { meetings: Meeting[]; onNew: () => void }) {
  const [showPast, setShowPast] = React.useState(false);
  const upcoming = meetings.filter((m) => !isPast(m));
  const past = meetings.filter((m) => isPast(m)).reverse();
  const groups: { label: string; items: Meeting[] }[] = [];
  for (const m of upcoming) {
    const label = dayLabel(m.start);
    const g = groups.find((x) => x.label === label);
    if (g) g.items.push(m);
    else groups.push({ label, items: [m] });
  }
  return (
    <div className="grid max-w-4xl gap-6">
      {upcoming.length === 0 ? (
        <EmptyState icon={<CalendarClock />} title="No upcoming meetings" description="Schedule one and invite your team." action={<Button onClick={onNew}>New meeting</Button>} />
      ) : (
        groups.map((g) => (
          <section key={g.label}>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{g.label}</h2>
            <div className="grid gap-2">
              {g.items.map((m) => (
                <MeetingCard key={m.id} m={m} />
              ))}
            </div>
          </section>
        ))
      )}
      {past.length > 0 && (
        <section>
          <Button variant="ghost" size="sm" onClick={() => setShowPast((s) => !s)} aria-expanded={showPast}>
            {showPast ? "Hide" : "Show"} past meetings ({past.length})
          </Button>
          {showPast && (
            <div className="mt-2 grid gap-2">
              {past.map((m) => (
                <MeetingCard key={m.id} m={m} past />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function MeetingCard({ m, past }: { m: Meeting; past?: boolean }) {
  const viewer = useViewer();
  const router = useRouter();
  const me = viewer?.employee.empId;
  const mine = m.participants.find((p) => p.empId === me);
  const organizer = m.organizer === me;
  const going = m.participants.filter((p) => p.rsvp === "yes").length;
  return (
    <Card
      role="link"
      tabIndex={0}
      onClick={() => router.push(`/meetings/${m.id}`)}
      onKeyDown={(e) => e.key === "Enter" && router.push(`/meetings/${m.id}`)}
      className={cn("flex cursor-pointer flex-wrap items-center gap-4 px-4 py-3 transition hover:shadow-float", (past || m.cancelled) && "opacity-70")}
    >
      <div className="grid w-20 shrink-0 text-center">
        <span className="text-[15px] font-semibold tabular">{timeRange(m).split("–")[0]}</span>
        <span className="text-[11.5px] text-muted-foreground tabular">{m.durationMin} min</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-[14px] font-semibold", m.cancelled && "line-through")}>{m.title}</p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3" /> {m.location}
          </span>
          {m.linkedTaskIds.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <ListTodo className="size-3" /> {m.linkedTaskIds.length} task{m.linkedTaskIds.length === 1 ? "" : "s"}
            </span>
          )}
          {m.attachments.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Paperclip className="size-3" /> {m.attachments.length}
            </span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <span className="hidden text-[12px] text-muted-foreground sm:block">{going + (organizer ? 1 : 0)} going</span>
        <AvatarStack empIds={[m.organizer, ...m.participants.map((p) => p.empId)]} max={4} size={24} />
      </div>
      <div className="w-full sm:w-auto">
        {m.cancelled ? (
          <Badge tone="neutral">Cancelled</Badge>
        ) : organizer ? (
          <Badge tone="primary">You organise</Badge>
        ) : mine && !past ? (
          <RsvpControl meetingId={m.id} value={mine.rsvp} size="sm" />
        ) : mine ? (
          <RsvpBadge rsvp={mine.rsvp} />
        ) : null}
      </div>
    </Card>
  );
}

const START_HOUR = 8;
const END_HOUR = 18;
const HOUR_PX = 52;

function WeekView({ meetings }: { meetings: Meeting[] }) {
  const [week, setWeek] = React.useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const days = Array.from({ length: 5 }, (_, i) => addDays(week, i));
  const hours = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i);
  const now = new Date();
  const nowTop = ((now.getHours() + now.getMinutes() / 60 - START_HOUR) * HOUR_PX);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <p className="font-semibold">
          {formatDateShort(days[0])} – {formatDateShort(days[4])}
        </p>
        <div className="flex gap-1">
          <Button size="icon-sm" variant="ghost" onClick={() => setWeek((w) => addWeeks(w, -1))} aria-label="Previous week">
            <ChevronLeft />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setWeek(startOfWeek(new Date(), { weekStartsOn: 1 }))}>
            This week
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={() => setWeek((w) => addWeeks(w, 1))} aria-label="Next week">
            <ChevronRight />
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <div className="grid min-w-[720px] grid-cols-[56px_repeat(5,minmax(0,1fr))]">
          <div className="border-b border-border" />
          {days.map((d) => (
            <div key={d.toISOString()} className={cn("border-b border-l border-border px-2 py-2 text-center", isToday(d) && "bg-signal/15")}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{formatWeekday(d)}</p>
              <p className={cn("mx-auto mt-0.5 grid size-7 place-content-center rounded-full text-[14px] font-semibold tabular", isToday(d) && "bg-signal text-signal-foreground")}>{d.getDate()}</p>
            </div>
          ))}
          <div className="relative">
            {hours.map((h) => (
              <div key={h} className="relative border-b border-border text-right" style={{ height: HOUR_PX }}>
                <span className="absolute -top-2 right-2 text-[10.5px] text-muted-foreground tabular">{String(h).padStart(2, "0")}:00</span>
              </div>
            ))}
          </div>
          {days.map((d) => {
            const dayMeetings = meetings.filter((m) => isSameDay(new Date(m.start), d));
            return (
              <div key={d.toISOString()} className="relative border-l border-border">
                {hours.map((h) => (
                  <div key={h} className="border-b border-dashed border-border/70" style={{ height: HOUR_PX }} />
                ))}
                {isToday(d) && nowTop > 0 && nowTop < hours.length * HOUR_PX && (
                  <div className="absolute inset-x-0 z-[2] h-0.5 bg-danger" style={{ top: nowTop }} aria-hidden>
                    <span className="absolute -left-1 -top-1 size-2.5 rounded-full bg-danger" />
                  </div>
                )}
                {dayMeetings.map((m) => {
                  const s = new Date(m.start);
                  const top = (s.getHours() + s.getMinutes() / 60 - START_HOUR) * HOUR_PX;
                  const height = Math.max(24, (m.durationMin / 60) * HOUR_PX - 3);
                  return (
                    <Link
                      key={m.id}
                      href={`/meetings/${m.id}`}
                      className={cn(
                        "absolute inset-x-1 z-[1] overflow-hidden rounded-md border-l-[3px] border-zone-work bg-zone-work/14 px-2 py-1 text-[11.5px] leading-tight transition hover:bg-zone-work/22",
                        (isPast(m) || m.cancelled) && "opacity-55",
                      )}
                      style={{ top: Math.max(0, top) + 1, height }}
                    >
                      <span className={cn("block truncate font-semibold", m.cancelled && "line-through")}>{m.title}</span>
                      {height > 34 && <span className="block truncate text-muted-foreground tabular">{timeRange(m)}</span>}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <p className="border-t border-border px-4 py-2 text-[12px] text-muted-foreground">
        Working hours 08:00–18:00, Monday to Friday.
      </p>
    </Card>
  );
}
