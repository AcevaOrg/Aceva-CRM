"use client";
import { isTopLevelRole } from "@/types";
import { BarChart3, Clock, Search, ShieldAlert, UserRound, Users } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { useUrlState } from "@/hooks/use-url-state";
import { useViewer } from "@/lib/auth/viewer";
import { useSecurityAlerts } from "../hooks";
import { activityAccess } from "../logic";
import { FairUseButton } from "./activity-bits";
import { AlertsPanel } from "./alerts-panel";
import { MyActivityPanel } from "./my-activity-panel";
import { OnlinePanel } from "./online-panel";
import { ReportsPanel } from "./reports-panel";
import { SearchPanel } from "./search-panel";
import { TimelinePanel } from "./timeline-panel";

type Tab = "online" | "timeline" | "search" | "reports" | "alerts" | "mine";

/** /activity: Module 4 screens (spec §9.4). Employees land on "mine". */
export function ActivityScreen() {
  const viewer = useViewer();
  const access = activityAccess(viewer);
  const team = access.online || access.reports;
  const fallback: Tab = access.online ? "online" : access.reports ? "reports" : "mine";
  const [tab, setTab] = useUrlState<Tab>("tab", fallback);
  const openAlerts = useSecurityAlerts("open").data?.length ?? 0;

  const allowed: Record<Tab, boolean> = { online: access.online, timeline: access.timeline, search: access.search, reports: access.reports, alerts: access.alerts, mine: true };
  const current = allowed[tab] ? tab : fallback;

  return (
    <RequireAccess permission="activity.view_own">
      <PageHeader
        title="Activity"
        description={
          team
            ? (viewer && isTopLevelRole(viewer.employee.role))
              ? "Who did what and when inside the system, for everyone in the company. Nobody can edit or delete tracking data."
              : "Who did what and when inside the system, for everyone below you in your reporting line. Nobody can edit or delete tracking data."
            : "What the system records about you. You can always see your own history."
        }
        seal={team ? "confidential" : "own"}
        actions={<FairUseButton />}
      />
      <Tabs value={current} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {access.online && <TabsTrigger value="online"><Users /> Online now</TabsTrigger>}
          {access.timeline && <TabsTrigger value="timeline"><Clock /> Timeline</TabsTrigger>}
          {access.search && <TabsTrigger value="search"><Search /> Search</TabsTrigger>}
          {access.reports && <TabsTrigger value="reports"><BarChart3 /> Reports</TabsTrigger>}
          {access.alerts && (
            <TabsTrigger value="alerts">
              <ShieldAlert /> Alerts
              {openAlerts > 0 && <span className="grid h-4.5 min-w-4.5 place-content-center rounded-full bg-danger px-1 text-[10px] font-bold text-white tabular">{openAlerts}</span>}
            </TabsTrigger>
          )}
          <TabsTrigger value="mine"><UserRound /> My activity</TabsTrigger>
        </TabsList>
        {access.online && <TabsContent value="online"><OnlinePanel /></TabsContent>}
        {access.timeline && <TabsContent value="timeline"><TimelinePanel /></TabsContent>}
        {access.search && <TabsContent value="search"><SearchPanel /></TabsContent>}
        {access.reports && <TabsContent value="reports"><ReportsPanel /></TabsContent>}
        {access.alerts && <TabsContent value="alerts"><AlertsPanel /></TabsContent>}
        <TabsContent value="mine"><MyActivityPanel /></TabsContent>
      </Tabs>
    </RequireAccess>
  );
}
