/**
 * Module 5 · Task management, size and deadline (plan §9)
 * Owner: Developer B (cycle 2). Spec §9.5.
 * API contract for the module.
 */
import type { Attachment } from "@/types";

export type TaskSize = "XS" | "S" | "M" | "L" | "XL";
export type TaskStatus = "assigned" | "in_progress" | "submitted" | "under_review" | "approved" | "rework" | "on_hold" | "cancelled";
export type Priority = "low" | "medium" | "high" | "urgent";

export interface RepeatRule {
  every: "week" | "month";
  /** 1 = Monday … 5 = Friday (weekly) or day of month (monthly). */
  on: number;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  number: string;
  title: string;
  description: string;
  assignee: string;
  assignedBy: string;
  projectId?: string;
  goalId?: string;
  priority: Priority;
  size: TaskSize;
  points: number;
  estimatedHours: number;
  startDate: string;
  deadline: string;
  originalDeadline: string;
  status: TaskStatus;
  isOverdue: boolean;
  checklist: ChecklistItem[];
  attachments: Attachment[];
  repeat?: RepeatRule;
  /** Personal to-do: not scored (plan §9). */
  personal: boolean;
  rating?: 1 | 2 | 3 | 4 | 5;
  reviewComment?: string;
  submittedAt?: string;
  extensionsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  body: string;
  mentions: string[];
  attachments: Attachment[];
  at: string;
}

export interface ExtensionRequest {
  id: string;
  taskId: string;
  requestedBy: string;
  currentDeadline: string;
  requestedDeadline: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  /** Asked after the deadline: counts as late (plan §9). */
  late: boolean;
  decidedBy?: string;
  decidedAt?: string;
  at: string;
}

export interface StatusChange {
  id: string;
  taskId: string;
  from: TaskStatus | null;
  to: TaskStatus;
  by: string;
  at: string;
  reason?: string;
}

export interface SizeRule {
  size: TaskSize;
  meaning: string;
  hours: number;
  hoursLabel: string;
  points: number;
  /** Suggested working days; null = must be split. */
  days: number | null;
}

export interface Project {
  id: string;
  name: string;
  client?: string;
}

export interface WorkloadRow {
  empId: string;
  openHours: number;
  capacity: number;
  openTasks: number;
}

export interface TaskListParams {
  scope: "mine" | "team" | "all";
  assignee?: string;
  includePersonal?: boolean;
}

export interface NewTaskInput {
  title: string;
  description: string;
  assignee: string;
  projectId?: string;
  priority: Priority;
  size: TaskSize;
  estimatedHours: number;
  startDate: string;
  deadline: string;
  checklist: string[];
  repeat?: RepeatRule;
  personal?: boolean;
}
