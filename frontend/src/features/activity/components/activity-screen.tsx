"use client";
import { BarChart3, Clock, Search, ShieldAlert, UserRound, Users } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { useUrlState } from "@/hooks/use-url-state";
import { useViewer } from "@/lib/auth/viewer";
import { useSecurityAlerts } from "../hooks";
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
  const all = !!viewer?.can("activity.view_all");
  const team = !!viewer?.can("activity.view_team");
  const security = all || !!viewer?.can("activity.security");
  const fallback: Tab = all ? "online" : team ? "reports" : "mine";
  const [tab, setTab] = useUrlState<Tab>("tab", fallback);
  const openAlerts = useSecurityAlerts("open").data?.length ?? 0;

  const allowed: Record<Tab, boolean> = { online: all, timeline: team || all, search: all, reports: team || all, alerts: security, mine: true };
  const current = allowed[tab] ? tab : fallback;

  return (
    <RequireAccess permission="activity.view_own">
      <PageHeader
        title="Activity"
        description={
          all
            ? "Who did what and when inside the system, for everyone in your reporting line. Nobody can edit or delete tracking data."
            : team
              ? "Your team's daily summaries and your own history. Nobody can edit or delete tracking data."
              : "What the system records about you. You can always see your own history."
        }
        seal={all || team ? "confidential" : "own"}
        actions={<FairUseButton />}
      />
      <Tabs value={current} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          {all && <TabsTrigger value="online"><Users /> Online now</TabsTrigger>}
          {(team || all) && <TabsTrigger value="timeline"><Clock /> Timeline</TabsTrigger>}
          {all && <TabsTrigger value="search"><Search /> Search</TabsTrigger>}
          {(team || all) && <TabsTrigger value="reports"><BarChart3 /> Reports</TabsTrigger>}
          {security && (
            <TabsTrigger value="alerts">
              <ShieldAlert /> Alerts
              {openAlerts > 0 && <span className="grid h-4.5 min-w-4.5 place-content-center rounded-full bg-danger px-1 text-[10px] font-bold text-white tabular">{openAlerts}</span>}
            </TabsTrigger>
          )}
          <TabsTrigger value="mine"><UserRound /> My activity</TabsTrigger>
        </TabsList>
        {all && <TabsContent value="online"><OnlinePanel /></TabsContent>}
        {(team || all) && <TabsContent value="timeline"><TimelinePanel /></TabsContent>}
        {all && <TabsContent value="search"><SearchPanel /></TabsContent>}
        {(team || all) && <TabsContent value="reports"><ReportsPanel /></TabsContent>}
        {security && <TabsContent value="alerts"><AlertsPanel /></TabsContent>}
        <TabsContent value="mine"><MyActivityPanel /></TabsContent>
      </Tabs>
    </RequireAccess>
  );
}
