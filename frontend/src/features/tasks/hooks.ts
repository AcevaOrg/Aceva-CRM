"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { tasksApi } from "./api";
import type { NewTaskInput, TaskListParams, TaskStatus } from "./types";

export const taskKeys = {
  all: ["tasks"] as const,
  list: (empId: string | null, p: TaskListParams) => ["tasks", "list", empId, p] as const,
  detail: (id: string) => ["tasks", "detail", id] as const,
  workload: (empId: string | null) => ["tasks", "workload", empId] as const,
};

/** Tasks visible to the viewer. scope "mine" | "team" | "all". */
export function useTasks(params: TaskListParams) {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: taskKeys.list(empId, params), queryFn: () => tasksApi.list(params), enabled: !!empId });
}

export function useTask(id: string) {
  return useQuery({ queryKey: taskKeys.detail(id), queryFn: () => tasksApi.get(id) });
}

/** Open hours vs capacity for everyone below the viewer. */
export function useWorkload() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: taskKeys.workload(empId), queryFn: tasksApi.workload, enabled: !!empId });
}

export function useProjects() {
  return useQuery({ queryKey: ["tasks", "projects"], queryFn: tasksApi.projects, staleTime: Infinity });
}

export function useHolidays() {
  return useQuery({ queryKey: ["tasks", "holidays"], queryFn: tasksApi.holidays, staleTime: Infinity });
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

export function useTransitionTask() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, to, reason, rating, comment }: { id: string; to: TaskStatus; reason?: string; rating?: number; comment?: string }) =>
      tasksApi.transition(id, to, { reason, rating, comment }),
    onSuccess: done,
  });
}

export function useChangeDeadline() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, deadline, reason }: { id: string; deadline: string; reason: string }) => tasksApi.changeDeadline(id, deadline, reason), onSuccess: done });
}

export function useToggleChecklist() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, itemId }: { id: string; itemId: string }) => tasksApi.toggleChecklist(id, itemId), onSuccess: done });
}

export function useAddComment() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: string }) => tasksApi.comment(id, body), onSuccess: done });
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
