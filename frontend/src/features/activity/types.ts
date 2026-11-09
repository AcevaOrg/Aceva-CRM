/**
 * Module 4 · Employee activity tracking (plan §8)
 * Owner: Developer A (cycle 2). Spec §9.4.
 * API contract for the module. Tracking tables are append-only: no edit, no delete.
 */

export type ActivitySource = "aceva" | "apollo" | "millionverifier" | "mailbox";

export type ActivityAction =
  | "login" | "logout" | "login_failed" | "screen_view"
  | "create" | "edit" | "delete" | "submit" | "assign" | "approve" | "reject" | "comment"
  | "upload" | "download" | "export" | "print"
  | "sensitive_view" | "blocked" | "security"
  | "email_sent" | "reply" | "bounce" | "call" | "email_check";

export type LogoutHow = "clicked" | "timed_out" | "forced" | "password_changed";

export interface FieldDiff {
  field: string;
  from: string;
  to: string;
}

export interface ActivityEvent {
  id: string;
  empId: string;
  at: string;
  source: ActivitySource;
  action: ActivityAction;
  module: string;
  target?: string;
  description: string;
  changes?: FieldDiff[];
  ip?: string;
  city?: string;
  device?: string;
  /** For logout events. */
  how?: LogoutHow;
}

export interface OnlineSession {
  sessionId: string;
  empId: string;
  since: string;
  currentScreen: string;
  state: "active" | "idle";
  device: string;
  city: string;
  newDevice?: boolean;
}

export interface IdleSpan {
  from: string;
  to: string;
}

export interface DailySummary {
  empId: string;
  date: string;
  firstLogin?: string;
  lastLogout?: string;
  activeMinutes: number;
  idleMinutes: number;
  actions: number;
  tasksTouched: number;
  /** Attendance check-in (Module 7), shown next to the first login. */
  checkIn?: string;
  idleSpans?: IdleSpan[];
}

export type AlertSeverity = "low" | "medium" | "high";

export interface SecurityAlert {
  id: string;
  rule: string;
  severity: AlertSeverity;
  empId: string;
  at: string;
  details: string;
  status: "open" | "checked";
  checkedBy?: string;
  checkedAt?: string;
  note?: string;
  /** For "account locked" alerts: the account can be unlocked from the alert. */
  kind?: "account_locked" | "new_device" | "finance_attempts" | "large_export" | "outside_hours" | "salary_views";
}

export interface AccountLock {
  empId: string;
  at: string;
  by: string;
  reason: string;
}

export interface ActivityQuery {
  empId?: string;
  departmentId?: string;
  module?: string;
  action?: ActivityAction | "";
  source?: ActivitySource | "";
  from?: string;
  to?: string;
}

/** The viewer's own activity page ("mine"). */
export interface MyActivity {
  today?: DailySummary;
  events: ActivityEvent[];
  liveScreens: { at: string; screen: string }[];
  heartbeats: { at: string; active: boolean }[];
}
