/**
 * Module 2 service functions. Mock today; JSDoc names the real endpoint (spec §7.3).
 * Mock rules: any non-empty password works for a known Emp-ID; 5 wrong tries lock the account.
 */
import type { MeResponse, TwoFactorSetupResponse } from "@aceva/contracts";
import { setCsrf } from "@/lib/api/csrf";
import { http, isLive } from "@/lib/api/http";
import { mock } from "@/lib/api/mock";
import type { ServerStage } from "@/lib/auth/session";
import { getViewer, requires2fa } from "@/lib/auth/viewer";
import { table } from "@/mocks/db";
import { EMPLOYEES } from "@/mocks/seed/people";
import { daysFromNow, minutesAgo } from "@/mocks/time";
import type { LoginHistoryItem, LoginRequest, LoginResult, SessionInfo } from "./types";

/** Module 2 talks to the real server when it is switched to live (NEXT_PUBLIC_LIVE_MODULES=m1,m2). */
const live = () => isLive("m2");

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
  login: async ({ empId, password, rememberMe }: LoginRequest & { rememberMe?: boolean }): Promise<LoginResult> => {
    if (live()) {
      const res = await http.post<LoginResult>("/auth/login", { empId, password, rememberMe });
      if (res.csrfToken) setCsrf(res.csrfToken);
      return res;
    }
    return mock<LoginResult>(() => {
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
    }, { delay: 500 });
  },

  /** GET /auth/me: who is logged in, how far the login has got, and the CSRF token. Live only. */
  me: async (): Promise<MeResponse> => {
    const res = await http.get<MeResponse>("/auth/me");
    setCsrf(res.csrfToken);
    return res;
  },

  /** POST /auth/2fa/verify */
  verify2fa: async (code: string): Promise<{ ok: boolean; stage?: ServerStage }> => {
    if (live()) {
      const res = await http.post<{ stage: ServerStage }>("/auth/2fa/verify", { code });
      return { ok: true, stage: res.stage };
    }
    return mock(() => ({ ok: /^\d{6}$/.test(code) }), { delay: 400 });
  },

  /** POST /auth/password/forgot */
  forgotPassword: async (empId: string) =>
    live() ? http.post<{ sent: boolean }>("/auth/password/forgot", { empId }) : mock(() => ({ sent: EMPLOYEES.some((e) => e.empId === empId) }), { delay: 500 }),

  /** POST /auth/password/reset { token, newPassword }: the one-time link from the email */
  resetPassword: async (token: string, newPassword: string) =>
    live() ? http.post<{ ok: boolean }>("/auth/password/reset", { token, newPassword }) : mock(() => ({ ok: newPassword.length >= 10 }), { delay: 400 }),

  /** POST /auth/password/change */
  changePassword: async (newPassword: string, currentPassword?: string): Promise<{ ok: boolean; stage?: ServerStage }> => {
    if (live()) {
      const res = await http.post<{ ok: boolean; stage: ServerStage; csrfToken: string }>("/auth/password/change", { newPassword, currentPassword });
      setCsrf(res.csrfToken); // the server started a fresh session for this device
      return { ok: res.ok, stage: res.stage };
    }
    return mock(() => ({ ok: newPassword.length >= 10 }), { delay: 400 });
  },

  /** POST /auth/policy/accept */
  acceptPolicy: (version: string) => mock(() => ({ ok: true, version })),

  /** POST /auth/2fa/setup */
  setup2fa: async (): Promise<TwoFactorSetupResponse> =>
    live() ? http.post<TwoFactorSetupResponse>("/auth/2fa/setup", {}) : mock(() => ({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Aceva" })),

  /** POST /auth/2fa/disable { password, code } (only where two-step login is optional). Live only. */
  disable2fa: (password: string, code: string) => http.post<{ ok: boolean }>("/auth/2fa/disable", { password, code }),

  /** GET /auth/sessions */
  sessions: (): Promise<SessionInfo[]> =>
    live() ? http.get<SessionInfo[]>("/auth/sessions") : mock(() => sessionsTable().filter((s) => s.empId === getViewer().employee.empId)),

  /** DELETE /auth/sessions/:id  ·  DELETE /auth/sessions (all others) */
  endSession: (id?: string): Promise<unknown> => {
    if (live()) return id ? http.delete(`/auth/sessions/${id}`) : http.delete("/auth/sessions");
    return mock(() => {
      const me = getViewer().employee.empId;
      const list = sessionsTable();
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        if (s.empId === me && !s.current && (!id || s.id === id)) list.splice(i, 1);
      }
    });
  },

  /** GET /auth/login-history */
  loginHistory: (): Promise<LoginHistoryItem[]> =>
    live() ? http.get<LoginHistoryItem[]>("/auth/login-history") : mock(() => historyTable().filter((h) => h.empId === getViewer().employee.empId)),

  /** GET /auth/2fa — required for the CEO / Founder / Owner, Director, CTO and Finance (finance duty); optional for Sales and Development */
  twoFactorStatus: (): Promise<TwoFactorStatus> =>
    live() ? http.get<TwoFactorStatus>("/auth/2fa") : mock<TwoFactorStatus>(() => {
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
