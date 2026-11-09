"use client";
import * as React from "react";
import Link from "next/link";
import { CalendarCheck, CalendarDays, CalendarPlus, Inbox, UserRound, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/controls";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, SectionTitle } from "@/components/layout/page-header";
import { EmptyState, QueryState } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { descendantsOf } from "@/lib/auth/scope";
import { useViewer } from "@/lib/auth/viewer";
import { currentLeaveApprover } from "../api";
import { useLeaveRequests } from "../hooks";
import { isPendingLeave } from "../logic";
import { LeaveBalanceCards } from "./leave-balances";
import { LeaveCalendar } from "./leave-calendar";
import { LeaveRequestCard } from "./leave-request-card";
import { RequestLeaveSheet } from "./request-leave-sheet";

type Tab = "me" | "team" | "calendar" | "approvals";

function MyLeave({ onRequest }: { onRequest: () => void }) {
  const q = useLeaveRequests("mine");
  return (
    <div className="grid gap-8">
      <section>
        <SectionTitle title="Balances this year" description="Waiting requests are held from your balance until they're decided." />
        <LeaveBalanceCards />
      </section>
      <section>
        <SectionTitle title="My requests" />
        <QueryState
          query={q}
          isEmpty={(d) => d.length === 0}
          empty={
            <EmptyState
              icon={<CalendarDays />}
              title="No leave requests yet"
              description="Plan time off early so your team can cover your tasks."
              action={
                <Button onClick={onRequest}>
                  <CalendarPlus /> Request leave
                </Button>
              }
            />
          }
        >
          {(list) => (
            <div className="grid gap-3">
              {list.map((r) => (
                <LeaveRequestCard key={r.id} r={r} />
              ))}
            </div>
          )}
        </QueryState>
      </section>
    </div>
  );
}

function TeamLeave() {
  const q = useLeaveRequests("team");
  const [filter, setFilter] = React.useState<"waiting" | "upcoming" | "all">("waiting");
  const today = new Date().toISOString().slice(0, 10);
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle title="Team requests" description="Everyone below you in the reporting line." className="mb-0" />
        <SegmentedControl
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "waiting", label: "Waiting" },
            { value: "upcoming", label: "Upcoming" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      <QueryState query={q}>
        {(list) => {
          const shown = list.filter((r) => (filter === "waiting" ? isPendingLeave(r.status) : filter === "upcoming" ? r.status === "approved" && r.to >= today : true));
          return shown.length ? (
            <div className="grid gap-3">
              {shown.map((r) => (
                <LeaveRequestCard key={r.id} r={r} showPerson />
              ))}
            </div>
          ) : (
            <EmptyState compact icon={<Users />} title={filter === "waiting" ? "Nothing waiting" : "No requests"} description="Requests from your team show here." />
          );
        }}
      </QueryState>
    </section>
  );
}

function LeaveApprovals() {
  const viewer = useViewer();
  const q = useLeaveRequests("team");
  return (
    <section className="grid gap-3">
      <SectionTitle title="Waiting for you" description="You approve as team lead or Director. You never approve your own leave." />
      <QueryState query={q}>
        {(list) => {
          const mine = list.filter((r) => currentLeaveApprover(r) === viewer?.employee.empId);
          return mine.length ? (
            <div className="grid gap-3">
              {mine.map((r) => (
                <LeaveRequestCard key={r.id} r={r} showPerson />
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              icon={<Inbox />}
              title="You're all caught up"
              description="No leave requests are waiting for you."
              action={
                <Button asChild variant="outline" size="sm">
                  <Link href="/approvals">Open all approvals</Link>
                </Button>
              }
            />
          );
        }}
      </QueryState>
    </section>
  );
}

export function LeaveScreen() {
  const viewer = useViewer();
  const [tab, setTab] = useUrlState<Tab>("tab", "me");
  const [request, setRequest] = useUrlState<"" | "1">("request", "");
  if (!viewer) return null;
  const hasTeam = descendantsOf(viewer.employee.empId).length > 0;
  const canApprove = viewer.can("leave.approve") && hasTeam;
  const current: Tab = (tab === "team" && !hasTeam) || (tab === "approvals" && !canApprove) ? "me" : tab;

  return (
    <>
      <PageHeader
        title="Leave"
        description="Request time off, see your balance and who's away."
        seal={current === "me" ? "own" : "internal"}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/attendance">
                <CalendarCheck /> Attendance
              </Link>
            </Button>
            <Button onClick={() => setRequest("1")}>
              <CalendarPlus /> Request leave
            </Button>
          </>
        }
      />
      <Tabs value={current} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="me">
            <UserRound /> My leave
          </TabsTrigger>
          {hasTeam && (
            <TabsTrigger value="team">
              <Users /> Team
            </TabsTrigger>
          )}
          <TabsTrigger value="calendar">
            <CalendarDays /> Calendar
          </TabsTrigger>
          {canApprove && (
            <TabsTrigger value="approvals">
              <Inbox /> Approvals
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="me">
          <MyLeave onRequest={() => setRequest("1")} />
        </TabsContent>
        {hasTeam && (
          <TabsContent value="team">
            <TeamLeave />
          </TabsContent>
        )}
        <TabsContent value="calendar">
          <LeaveCalendar />
        </TabsContent>
        {canApprove && (
          <TabsContent value="approvals">
            <LeaveApprovals />
          </TabsContent>
        )}
      </Tabs>
      <RequestLeaveSheet open={request === "1"} onOpenChange={(o) => setRequest(o ? "1" : "")} />
    </>
  );
}
