"use client";
import { Building2, KeyRound, Network, UserRoundCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { EmpChip } from "@/components/shared/emp-chip";
import { Timeline } from "@/components/shared/timeline";
import { useUrlState } from "@/hooks/use-url-state";
import { useCan } from "@/lib/auth/viewer";
import { formatRelative } from "@/lib/dates";
import { useOrgChanges } from "../hooks";
import { DepartmentsPanel } from "./departments-panel";
import { OrgChart } from "./org-chart";
import { RolesMatrix } from "./roles-matrix";
import { StandInsPanel } from "./stand-ins-panel";

type Tab = "chart" | "departments" | "roles" | "standins";

/** /org: Module 1 screens (spec §9.1). */
export function OrgScreen() {
  const [tab, setTab] = useUrlState<Tab>("tab", "chart");
  // The Director edits; the CEO / Founder / Owner (audit.view) sees the same tabs, view only.
  const canRoles = useCan(["roles.manage", "audit.view"]);
  const canStandIns = useCan(["standin.manage", "audit.view"]);
  const canManage = useCan("org.manage");

  return (
    <RequireAccess permission="org.view">
      <PageHeader
        title="Org and access"
        description={
          canManage
            ? "The company's reporting lines and who can do what. You can change levels and reporting lines; every change is logged."
            : "The company's reporting lines and who can do what. View only: the Director changes levels and reporting lines."
        }
        seal="internal"
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="chart">
            <Network /> Org chart
          </TabsTrigger>
          <TabsTrigger value="departments">
            <Building2 /> Departments and offices
          </TabsTrigger>
          {canRoles && (
            <TabsTrigger value="roles">
              <KeyRound /> Roles and permissions
            </TabsTrigger>
          )}
          {canStandIns && (
            <TabsTrigger value="standins">
              <UserRoundCheck /> Stand-ins
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="chart" className="grid gap-6">
          <OrgChart />
          {canRoles && <RecentChanges />}
        </TabsContent>
        <TabsContent value="departments">
          <DepartmentsPanel />
        </TabsContent>
        {canRoles && (
          <TabsContent value="roles">
            <RolesMatrix />
          </TabsContent>
        )}
        {canStandIns && (
          <TabsContent value="standins">
            <StandInsPanel />
          </TabsContent>
        )}
      </Tabs>
    </RequireAccess>
  );
}

function RecentChanges() {
  const { data } = useOrgChanges();
  if (!data?.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent access changes</CardTitle>
      </CardHeader>
      <CardContent>
        <Timeline
          items={data.slice(0, 6).map((c) => ({
            id: c.id,
            title: c.summary,
            meta: (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                by <EmpChip empId={c.by} size="sm" showId={false} /> · “{c.reason}”
              </span>
            ),
            time: formatRelative(c.at),
            color: "var(--zone-control)",
          }))}
        />
      </CardContent>
    </Card>
  );
}
