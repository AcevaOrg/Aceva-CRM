"use client";
import * as React from "react";
import Link from "next/link";
import { Activity, ArrowRight, MonitorSmartphone, Moon, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/shared/metrics";
import { CardsSkeleton, EmptyState, QueryState } from "@/components/shared/states";
import { Timeline } from "@/components/shared/timeline";
import { useLoginHistory } from "@/features/auth/hooks";
import { formatDateTime, formatTime, isoDay } from "@/lib/dates";
import { minutesToHours } from "@/lib/format";
import { useMyActivity } from "../hooks";
import { SummaryBlock, eventItem } from "./timeline-panel";

/** "My activity": what the system recorded about you (everyone can see their own). */
export function MyActivityPanel() {
  const query = useMyActivity();
  const history = useLoginHistory();
  return (
    <QueryState query={query} skeleton={<CardsSkeleton count={3} />}>
      {(d) => {
        const today = isoDay(new Date());
        const todayEvents = d.events.filter((e) => isoDay(e.at) === today);
        const beats = d.heartbeats;
        const activeBeats = beats.filter((b) => b.active).length;
        return (
          <div className="grid gap-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="Active today" value={minutesToHours((d.today?.activeMinutes ?? 0) + activeBeats)} icon={<Activity />} accent="var(--signal)" hint="mouse or keyboard used" />
              <StatCard label="Idle today" value={minutesToHours((d.today?.idleMinutes ?? 0) + (beats.length - activeBeats))} icon={<Moon />} accent="var(--warning)" hint="5 min or more without input" />
              <StatCard label="Screens opened this session" value={d.liveScreens.length} icon={<MonitorSmartphone />} accent="var(--zone-control)" hint="recorded live as you click" />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>This session, live</CardTitle>
                    <CardDescription>Every screen you open sends one small event. Nothing else is read.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  {d.liveScreens.length ? (
                    <Timeline
                      items={d.liveScreens.slice(0, 10).map((s, i) => ({
                        id: `live_${i}`,
                        icon: <MonitorSmartphone />,
                        color: i === 0 ? "var(--signal-foreground)" : "var(--zone-control)",
                        title: `Opened ${s.screen}`,
                        meta: i === 0 ? "Now" : undefined,
                        time: formatTime(s.at),
                      }))}
                    />
                  ) : (
                    <EmptyState compact title="Nothing yet" description="Open a few pages; they appear here." />
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Today</CardTitle>
                    <CardDescription>Your check-in next to your first login, and the day so far.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-5">
                  {d.today ? <SummaryBlock s={d.today} /> : <p className="text-[13px] text-muted-foreground">No summary yet for today. It is built every night.</p>}
                  {todayEvents.length > 0 && <Timeline items={todayEvents.slice(0, 6).map(eventItem)} />}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Recent logins</CardTitle>
                  <CardDescription>Spot anything you don&apos;t recognise? Sign out that device and tell the CTO.</CardDescription>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link href="/account?tab=devices">
                    <Timer /> My devices <ArrowRight />
                  </Link>
                </Button>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-border">
                  {(history.data ?? []).slice(0, 5).map((h) => (
                    <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
                      <span className="tabular">{formatDateTime(h.at)}</span>
                      <span className="text-muted-foreground">
                        {h.success ? "Signed in" : "Wrong password"} · {h.device} · {h.city}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
        );
      }}
    </QueryState>
  );
}
