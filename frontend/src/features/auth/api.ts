/**
 * Module 2 service functions. Mock today; JSDoc names the real endpoint (spec §7.3).
 * Mock rules: any non-empty password works for a known Emp-ID; 5 wrong tries lock the account.
 */
import { mock } from "@/lib/api/mock";
import { getViewer, requires2fa } from "@/lib/auth/viewer";
import { table } from "@/mocks/db";
import { EMPLOYEES } from "@/mocks/seed/people";
import { daysFromNow, minutesAgo } from "@/mocks/time";
import type { LoginHistoryItem, LoginRequest, LoginResult, SessionInfo } from "./types";

const attempts = () => table<{ empId: string; failed: number }>("auth.attempts", () => []);

const sessionsTable = () =>
  table<SessionInfo & { empId: string }>("auth.sessions", () =>
    EMPLOYEES.flatMap((e, i) => [
      { id: `ses_${e.empId}_1`, empId: e.empId, device: "Windows laptop", browser: "Chrome 142", os: "Windows 11", city: ["Karachi", "Dadu", "Hyderabad"][i % 3], ip: `39.45.12.${10 + i}`, startedAt: minutesAgo(180), lastActiveAt: minutesAgo(0), current: true },
      ...(i % 2 === 0
        ? [{ id: `ses_${e.empId}_2`, empId: e.empId, device: "Android phone", browser: "Chrome Mobile", os: "Android 16", city: "Karachi", ip: `110.93.4.${20 + i}`, startedAt: daysFromNow(-1, "20:14"), lastActiveAt: minutesAgo(600), current: false }]
        : []),
    ]),
  );

const historyTable = () =>
  table<LoginHistoryItem & { empId: string }>("auth.history", () =>
    EMPLOYEES.flatMap((e) =>
      Array.from({ length: 8 }, (_, d) => ({
        id: `lh_${e.empId}_${d}`,
        empId: e.empId,
        at: daysFromNow(-d, d % 3 === 0 ? "09:04" : "08:57"),
        endedAt: d === 0 ? undefined : daysFromNow(-d, d % 4 === 0 ? "13:40" : "18:06"),
        success: d !== 5,
        twoFactor: requires2fa(e),
        device: d % 3 === 2 ? "Android phone" : "Windows laptop",
        city: d === 3 ? "Lahore" : "Karachi",
        ip: `39.45.12.${30 + d}`,
        endReason: d === 0 ? undefined : d % 4 === 0 ? ("timed_out" as const) : ("clicked" as const),
      })),
    ),
  );

export const authApi = {
  /** POST /auth/login */
  login: ({ empId, password }: LoginRequest) =>
    mock<LoginResult>(() => {
      const emp = EMPLOYEES.find((e) => e.empId === empId);
      const list = attempts();
      let rec = list.find((a) => a.empId === empId);
      if (!rec) list.push((rec = { empId, failed: 0 }));
      if (rec.failed >= 5) return { status: "locked" };
      if (!emp || emp.status === "left" || !password) {
        rec.failed++;
        return rec.failed >= 5 ? { status: "locked" } : { status: "invalid", attemptsLeft: 5 - rec.failed };
      }
      rec.failed = 0;
      return { status: requires2fa(emp) ? "2fa_required" : "ok" };
    }, { delay: 500 }),

  /** POST /auth/2fa/verify */
  verify2fa: (code: string) => mock(() => ({ ok: /^\d{6}$/.test(code) }), { delay: 400 }),

  /** POST /auth/password/forgot */
  forgotPassword: (empId: string) => mock(() => ({ sent: EMPLOYEES.some((e) => e.empId === empId) }), { delay: 500 }),

  /** POST /auth/password/change */
  changePassword: (newPassword: string) => mock(() => ({ ok: newPassword.length >= 10 }), { delay: 400 }),

  /** POST /auth/policy/accept */
  acceptPolicy: (version: string) => mock(() => ({ ok: true, version })),

  /** POST /auth/2fa/setup */
  setup2fa: () => mock(() => ({ secret: "JBSW Y3DP EHPK 3PXP", otpauthUrl: "otpauth://totp/Aceva" })),

  /** GET /auth/sessions */
  sessions: () => mock(() => sessionsTable().filter((s) => s.empId === getViewer().employee.empId)),

  /** DELETE /auth/sessions/:id  ·  DELETE /auth/sessions (all others) */
  endSession: (id?: string) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const list = sessionsTable();
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        if (s.empId === me && !s.current && (!id || s.id === id)) list.splice(i, 1);
      }
    }),

  /** GET /auth/login-history */
  loginHistory: () => mock(() => historyTable().filter((h) => h.empId === getViewer().employee.empId)),

  /** GET /auth/2fa — required for levels 1–3 and finance duty, optional for others */
  twoFactorStatus: () =>
    mock<TwoFactorStatus>(() => {
      const me = getViewer().employee;
      const required = requires2fa(me);
      const rec = twoFactorTable().find((t) => t.empId === me.empId);
      return { required, enabled: required || !!rec?.enabled, enabledAt: rec?.enabledAt ?? (required ? daysFromNow(-90) : undefined) };
    }),

  /** POST /auth/2fa/enable · POST /auth/2fa/disable (only when optional) */
  setTwoFactor: (enabled: boolean) =>
    mock(() => {
      const me = getViewer().employee;
      if (requires2fa(me) && !enabled) throw new Error("Two-step login is required for your level or duty.");
      const list = twoFactorTable();
      const rec = list.find((t) => t.empId === me.empId);
      if (rec) Object.assign(rec, { enabled, enabledAt: enabled ? new Date().toISOString() : undefined });
      else list.push({ empId: me.empId, enabled, enabledAt: enabled ? new Date().toISOString() : undefined });
    }),
};

export interface TwoFactorStatus {
  required: boolean;
  enabled: boolean;
  enabledAt?: string;
}

const twoFactorTable = () => table<{ empId: string; enabled: boolean; enabledAt?: string }>("auth.2fa", () => []);
