"use client";
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, Columns3, Gauge, LayoutList, ListTodo, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/controls";
import { PageHeader } from "@/components/layout/page-header";
import { Can } from "@/components/shared/can";
import { useUrlState } from "@/hooks/use-url-state";
import { useViewer } from "@/lib/auth/viewer";
import { AssignTaskSheet } from "./assign-task-sheet";
import { MyTasksView, TaskBoardView, TaskCalendarView, TaskListView, WorkloadView } from "./task-views";

type View = "mine" | "list" | "board" | "calendar" | "workload";

export function TasksScreen() {
  const viewer = useViewer();
  const isManager = !!viewer?.can("task.view_team");
  const [view, setView] = useUrlState<View>("view", "mine");
  const [scope, setScope] = useUrlState<"mine" | "team">("scope", isManager ? "team" : "mine");
  const params = useSearchParams();
  const router = useRouter();
  const [manualOpen, setManualOpen] = React.useState(false);
  // ?assign=1 (from the command palette) opens the sheet; closing it clears the flag.
  const fromUrl = params.get("assign") === "1";
  const assignOpen = manualOpen || fromUrl;
  const setAssignOpen = (open: boolean) => {
    setManualOpen(open);
    if (!open && fromUrl) {
      const p = new URLSearchParams(params.toString());
      p.delete("assign");
      router.replace(`/tasks${p.size ? `?${p}` : ""}`, { scroll: false });
    }
  };

  const effectiveScope = isManager ? scope : "mine";

  return (
    <>
      <PageHeader
        title={view === "mine" ? "My tasks" : view === "workload" ? "Team workload" : "Tasks"}
        description={
          view === "mine"
            ? "Everything assigned to you, by deadline."
            : view === "workload"
              ? "Open task hours against each person's weekly capacity."
              : effectiveScope === "team"
                ? "Tasks of everyone below you in the reporting line."
                : "Your tasks."
        }
        seal="internal"
        actions={
          <Can permission="task.assign">
            <Button onClick={() => setAssignOpen(true)}>
              <Plus /> Assign task
            </Button>
          </Can>
        }
      />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<View>
          value={view}
          onChange={setView}
          ariaLabel="View"
          options={[
            { value: "mine", label: <><ListTodo /> <span className="hidden sm:inline">My tasks</span></> },
            { value: "list", label: <><LayoutList /> <span className="hidden sm:inline">List</span></> },
            { value: "board", label: <><Columns3 /> <span className="hidden sm:inline">Board</span></> },
            { value: "calendar", label: <><CalendarDays /> <span className="hidden sm:inline">Calendar</span></> },
            ...(isManager ? [{ value: "workload" as const, label: <><Gauge /> <span className="hidden sm:inline">Workload</span></> }] : []),
          ]}
        />
        {isManager && view !== "mine" && view !== "workload" && (
          <SegmentedControl
            size="sm"
            value={scope}
            onChange={setScope}
            ariaLabel="Whose tasks"
            options={[
              { value: "team", label: "My team" },
              { value: "mine", label: "Mine" },
            ]}
          />
        )}
      </div>

      {view === "mine" && <MyTasksView />}
      {view === "list" && <TaskListView scope={effectiveScope} />}
      {view === "board" && <TaskBoardView scope={effectiveScope} />}
      {view === "calendar" && <TaskCalendarView scope={effectiveScope} />}
      {view === "workload" && isManager && <WorkloadView />}

      <AssignTaskSheet open={assignOpen} onOpenChange={setAssignOpen} />
    </>
  );
}
