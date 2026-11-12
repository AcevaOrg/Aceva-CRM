/**
 * Module 2 · Emp-ID login and sessions (plan §6)
 * Owner: Developer B (cycle 1). Spec §9.2.
 * API contract for the module.
 */

export interface LoginRequest {
  empId: string;
  password: string;
}

export type LoginStatus = "ok" | "2fa_required" | "2fa_setup_required" | "password_change_required" | "locked" | "invalid" | "rate_limited";

export interface LoginResult {
  status: LoginStatus;
  /** Live login: the CSRF token for this session. */
  csrfToken?: string;
  attemptsLeft?: number;
  retryAfterSec?: number;
}

export interface SessionInfo {
  id: string;
  device: string;
  browser: string;
  os: string;
  city: string;
  ip: string;
  startedAt: string;
  lastActiveAt: string;
  current: boolean;
}

export type LogoutReason = "clicked" | "timed_out" | "forced" | "password_changed";

export interface LoginHistoryItem {
  id: string;
  at: string;
  endedAt?: string;
  success: boolean;
  twoFactor: boolean;
  device: string;
  city: string;
  ip: string;
  endReason?: LogoutReason;
}

/** Password rules (plan §6): 10+ chars, not one of the last 3, not the Emp-ID. */
export interface PasswordRuleResult {
  key: "length" | "notEmpId" | "mixed" | "notReused";
  label: string;
  ok: boolean;
}
