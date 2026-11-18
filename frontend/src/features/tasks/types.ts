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
  /** 1 = Monday … 5 = Friday (weekly) or day of month (monthly). The server also accepts 6 and 7 (weekend). */
  on: number;
  /** Last day of the series (YYYY-MM-DD); empty = until it is stopped. */
  until?: string;
  /** Live: false once the series was stopped. */
  active?: boolean;
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
  /** Live: how many times the reviewer sent it back. */
  reworkCount?: number;
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
  /** Live: why the request was rejected. */
  decisionReason?: string;
  at: string;
}

/** What a history line is (live only; the mock history has status lines and "Deadline changed" notes). */
export type HistoryKind =
  | "created"
  | "status"
  | "deadline_changed"
  | "extension_requested"
  | "extension_approved"
  | "extension_rejected"
  | "reassigned"
  | "transferred"
  | "edited"
  | "repeat_stopped";

export interface StatusChange {
  id: string;
  taskId: string;
  from: TaskStatus | null;
  to: TaskStatus;
  /** An Emp-ID, or "system" (repeating series, leaver hand-over, reminders). */
  by: string;
  at: string;
  reason?: string;
  /** Live: what the line is. Everything except "status" has from = to = the status at that moment. */
  kind?: HistoryKind;
  /** Live: small extras, for example { fromDeadline, toDeadline } or { fromEmpId, toEmpId }. */
  details?: Record<string, unknown>;
}

/** The status buttons the server knows: POST /tasks/:id/{action}. done and reopen are for a personal to-do only. */
export type TaskAction = "start" | "submit" | "review" | "approve" | "rework" | "hold" | "cancel" | "resume" | "done" | "reopen";

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
  /** Open work only (nothing approved or cancelled). Live only; the mock ignores it. */
  open?: boolean;
  /** Live: tasks approved or cancelled more than 90 days ago are left out unless "all" is asked for. Open tasks are always all there. */
  closed?: "recent" | "all";
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
  /** Live: true once the person has seen the soft warnings (deadline shorter than usual, overloaded week) and pressed Assign. */
  confirmWarnings?: boolean;
}
