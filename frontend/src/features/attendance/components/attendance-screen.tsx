"use client";
import Link from "next/link";
import { CalendarDays, ClipboardCheck, UserRound, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { useUrlState } from "@/hooks/use-url-state";
import { useViewer } from "@/lib/auth/viewer";
import { descendantsOf } from "@/lib/auth/scope";
import { CorrectionsPanel } from "./corrections-panel";
import { MyAttendance } from "./my-attendance";
import { TeamAttendance } from "./team-attendance";

type Tab = "me" | "team" | "corrections";

export function AttendanceScreen() {
  const viewer = useViewer();
  const [tab, setTab] = useUrlState<Tab>("tab", "me");
  if (!viewer) return null;
  const hasTeam = viewer.can("attendance.view_team") && descendantsOf(viewer.employee.empId).length > 0;
  const current = tab === "team" && !hasTeam ? "me" : tab;
  return (
    <>
      <PageHeader
        title="Attendance"
        description="Check in and out, see your month, and fix a wrong or missed entry."
        seal={current === "team" ? "internal" : "own"}
        actions={
          <Button asChild variant="outline">
            <Link href="/leave">
              <CalendarDays /> Leave
            </Link>
          </Button>
        }
      />
      <Tabs value={current} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="me">
            <UserRound /> My attendance
          </TabsTrigger>
          {hasTeam && (
            <TabsTrigger value="team">
              <Users /> Team
            </TabsTrigger>
          )}
          <TabsTrigger value="corrections">
            <ClipboardCheck /> Corrections
          </TabsTrigger>
        </TabsList>
        <TabsContent value="me">
          <MyAttendance />
        </TabsContent>
        {hasTeam && (
          <TabsContent value="team">
            <TeamAttendance />
          </TabsContent>
        )}
        <TabsContent value="corrections">
          <CorrectionsPanel />
        </TabsContent>
      </Tabs>
    </>
  );
}
