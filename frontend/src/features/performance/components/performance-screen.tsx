"use client";
import { ClipboardCheck, Gauge, Scale, Users } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { useTasks } from "@/features/tasks/hooks";
import { useUrlState } from "@/hooks/use-url-state";
import { descendantsOf } from "@/lib/auth/scope";
import { useViewer } from "@/lib/auth/viewer";
import { useDisputes } from "../hooks";
import { MyPerformance } from "./my-performance";
import { DisputesPanel, ReviewQueue, TeamPerformance } from "./team-tabs";

type Tab = "mine" | "team" | "reviews" | "disputes";

function Count({ n }: { n: number }) {
  if (!n) return null;
  return <span className="grid h-5 min-w-5 place-content-center rounded-full bg-signal px-1.5 text-[10.5px] font-bold text-signal-foreground tabular">{n}</span>;
}

export function PerformanceScreen() {
  const viewer = useViewer();
  const [tab, setTab] = useUrlState<Tab>("tab", "mine");
  const tasks = useTasks({ scope: "team" });
  const disputes = useDisputes();
  if (!viewer) return null;
  const me = viewer.employee.empId;
  const hasTeam = viewer.can(["performance.view_team", "performance.view_all"]) && (descendantsOf(me).length > 0 || viewer.can("performance.view_all"));
  const canReview = viewer.can("task.review");
  const reviews = (tasks.data ?? []).filter((t) => t.assignedBy === me && (t.status === "submitted" || t.status === "under_review")).length;
  const openDisputes = (disputes.data ?? []).filter((d) => d.status === "open" && d.deciderEmpId === me).length;
  const current: Tab = (tab === "team" && !hasTeam) || (tab === "reviews" && !canReview) ? "mine" : tab;

  return (
    <>
      <PageHeader
        title="Performance"
        description="Scores come from your reviewed tasks and attendance. Monthly scorecards are checked by the next level before release."
        seal={current === "mine" ? "own" : "confidential"}
      />
      <Tabs value={current} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="mine">
            <Gauge /> My performance
          </TabsTrigger>
          {hasTeam && (
            <TabsTrigger value="team">
              <Users /> Team
            </TabsTrigger>
          )}
          {canReview && (
            <TabsTrigger value="reviews">
              <ClipboardCheck /> Review queue <Count n={reviews} />
            </TabsTrigger>
          )}
          <TabsTrigger value="disputes">
            <Scale /> Disputes <Count n={openDisputes} />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="mine">
          <MyPerformance />
        </TabsContent>
        {hasTeam && (
          <TabsContent value="team">
            <TeamPerformance />
          </TabsContent>
        )}
        {canReview && (
          <TabsContent value="reviews">
            <ReviewQueue />
          </TabsContent>
        )}
        <TabsContent value="disputes">
          <DisputesPanel />
        </TabsContent>
      </Tabs>
    </>
  );
}
