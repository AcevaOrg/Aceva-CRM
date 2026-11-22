"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { useCan } from "@/lib/auth/viewer";
import type { Attachment } from "@/types";
import { tasksApi } from "./api";
import { SIZE_RULES } from "./logic";
import type { NewTaskInput, SizeRule, TaskListParams, TaskStatus } from "./types";

export const taskKeys = {
  all: ["tasks"] as const,
  list: (empId: string | null, p: TaskListParams) => ["tasks", "list", empId, p] as const,
  detail: (id: string) => ["tasks", "detail", id] as const,
  workload: (empId: string | null) => ["tasks", "workload", empId] as const,
};

/**
 * Tasks visible to the viewer. scope "mine" | "team" | "all".
 * The team list needs task.view_team. Without it the server answers 403 and records every refusal as a blocked attempt,
 * so the request is not made at all for people who lack the permission (the data then stays empty).
 */
export function useTasks(params: TaskListParams) {
  const empId = useSession((s) => s.empId);
  const canViewTeam = useCan("task.view_team");
  return useQuery({
    queryKey: taskKeys.list(empId, params),
    queryFn: () => tasksApi.list(params),
    enabled: !!empId && (params.scope !== "team" || canViewTeam),
  });
}

export function useTask(id: string) {
  return useQuery({ queryKey: taskKeys.detail(id), queryFn: () => tasksApi.get(id) });
}

/** Open hours vs capacity for everyone below the viewer. Needs task.view_team: nothing is requested without it (the server would answer 403 and log a blocked attempt). */
export function useWorkload() {
  const empId = useSession((s) => s.empId);
  const canViewTeam = useCan("task.view_team");
  return useQuery({ queryKey: taskKeys.workload(empId), queryFn: tasksApi.workload, enabled: !!empId && canViewTeam });
}

export function useProjects() {
  return useQuery({ queryKey: ["tasks", "projects"], queryFn: tasksApi.projects, staleTime: Infinity });
}

export function useHolidays() {
  return useQuery({ queryKey: ["tasks", "holidays"], queryFn: tasksApi.holidays, staleTime: Infinity });
}

/**
 * The size table (hours, points, suggested working days per size). Live it is the Director's table from the server;
 * until it has loaded (and in the mock) the default table is used, so a screen always has something to show.
 */
export function useSizeRules(): SizeRule[] {
  return useSizeRulesState().rules;
}

/**
 * The size table plus whether the server has answered yet (`ready`: loaded, or the request failed and the default table
 * stays). A form that takes its starting values from the table once, like the Assign sheet, waits for `ready` so it
 * never starts from the built-in table when the Director's table is on its way.
 */
export function useSizeRulesState(): { rules: SizeRule[]; ready: boolean } {
  const q = useQuery({ queryKey: ["tasks", "size-rules"], queryFn: tasksApi.sizeRules, staleTime: 5 * 60_000 });
  return { rules: q.data ?? SIZE_RULES, ready: !q.isPending };
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  };
}

export function useCreateTask() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: NewTaskInput) => tasksApi.create(input), onSuccess: done });
}

/**
 * Moves a task to a new status. `from` and `personal` are optional hints (the screens that have the task pass them);
 * without them the live API reads the task first to choose the right action (start, submit, approve, resume, done ...).
 */
export function useTransitionTask() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, to, reason, rating, comment, from, personal }: { id: string; to: TaskStatus; reason?: string; rating?: number; comment?: string; from?: TaskStatus; personal?: boolean }) =>
      tasksApi.transition(id, to, { reason, rating, comment, from, personal }),
    onSuccess: done,
  });
}

export function useChangeDeadline() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, deadline, reason, confirmWarnings }: { id: string; deadline: string; reason: string; confirmWarnings?: boolean }) =>
      tasksApi.changeDeadline(id, deadline, reason, confirmWarnings),
    onSuccess: done,
  });
}

export function useToggleChecklist() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, itemId }: { id: string; itemId: string }) => tasksApi.toggleChecklist(id, itemId), onSuccess: done });
}

export function useAddComment() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, body, file }: { id: string; body: string; file?: File }) => tasksApi.comment(id, body, file), onSuccess: done });
}

export function useAttachFile() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, file }: { id: string; file: File }) => tasksApi.attach(id, file), onSuccess: done });
}

/** Saves a file of a task or comment (live: permission-checked and logged on the server). Resolves false when nothing was saved (demo data). */
export function useDownloadAttachment() {
  return useMutation({ mutationFn: ({ taskId, file }: { taskId: string; file: Pick<Attachment, "id" | "fileName"> }) => tasksApi.downloadAttachment(taskId, file) });
}

export function useStopRepeat() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason?: string }) => tasksApi.stopRepeat(id, reason), onSuccess: done });
}

export function useRequestExtension() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, requestedDeadline, reason }: { id: string; requestedDeadline: string; reason: string }) => tasksApi.requestExtension(id, requestedDeadline, reason),
    onSuccess: done,
  });
}

export function useDecideExtension() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ extId, approve, reason }: { extId: string; approve: boolean; reason?: string }) => tasksApi.decideExtension(extId, approve, reason),
    onSuccess: done,
  });
}
