"use client";
/**
 * Client session (mock mode). In live mode the server owns the session through an
 * HTTP-only cookie and this store only caches who is signed in (spec §9.2).
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { setCsrf } from "@/lib/api/csrf";
import { isoDay } from "@/lib/dates";

export type SessionStage = "signed_out" | "needs_2fa" | "needs_2fa_setup" | "needs_first_login" | "signed_in";

/** What the real server says about how far a login has got (Module 2). */
export type ServerStage = "ok" | "password_change_required" | "2fa_required" | "2fa_setup_required";
const STAGE_FROM_SERVER: Record<ServerStage, SessionStage> = {
  ok: "signed_in",
  password_change_required: "needs_first_login",
  "2fa_required": "needs_2fa",
  "2fa_setup_required": "needs_2fa_setup",
};

interface DayCheck {
  date: string;
  in?: string;
  out?: string;
}

/** Live mode: who the server says is signed in (no tokens). Lets people hired after the demo roster use the app. */
export interface LiveMe {
  empId: string;
  name: string;
  level: number;
  roleKey: string;
  duties: string[];
}

interface SessionState {
  empId: string | null;
  liveMe: LiveMe | null;
  setLiveMe: (me: LiveMe | null) => void;
  stage: SessionStage;
  signedInAt: string | null;
  policyAccepted: Record<string, boolean>;
  checks: Record<string, DayCheck>;
  /** Start of the login flow for a persona. Returns the next stage. */
  beginSignIn: (empId: string, opts: { needs2fa: boolean }) => SessionStage;
  complete2fa: () => SessionStage;
  completeFirstLogin: () => void;
  /** Mock-only: switch persona without signing out (spec §2.2 "View as"). */
  viewAs: (empId: string) => void;
  /** Live mode: take the stage and Emp-ID the server reports. Returns the stage. */
  applyServerStage: (empId: string, stage: ServerStage) => SessionStage;
  /** Forget the login on this screen only (the server session is already gone). */
  signOutLocal: () => void;
  /** Ends the session on the server too (live mode), then forgets the login here. */
  signOut: () => void;
  checkIn: () => void;
  checkOut: () => void;
  todayCheck: () => DayCheck | undefined;
}

/** Module 7 live? (read from the build-time switch without importing the HTTP client here). */
function liveAttendance() {
  const modules = (process.env.NEXT_PUBLIC_LIVE_MODULES ?? "").split(",").map((m) => m.trim().toLowerCase());
  return process.env.NEXT_PUBLIC_API_MODE === "live" || modules.includes("m7");
}

/** Live check-in / check-out through the attendance API (loaded on demand to keep this store free of feature imports). */
async function liveCheck(kind: "in" | "out") {
  const [{ liveAttendanceApi }, { announceAttendanceChange }] = await Promise.all([import("@/features/attendance/live-api"), import("@/features/attendance/today")]);
  // A refusal (already checked in, office network, locked month) shows up as the server's state on every screen.
  await (kind === "in" ? liveAttendanceApi.checkIn() : liveAttendanceApi.checkOut()).catch(() => undefined);
  announceAttendanceChange();
}

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      empId: null,
      liveMe: null,
      setLiveMe: (me) => set({ liveMe: me }),
      stage: "signed_out",
      signedInAt: null,
      policyAccepted: {},
      checks: {},
      beginSignIn: (empId, { needs2fa }) => {
        const accepted = get().policyAccepted[empId];
        const stage: SessionStage = needs2fa ? "needs_2fa" : accepted ? "signed_in" : "needs_first_login";
        set({ empId, stage, signedInAt: stage === "signed_in" ? new Date().toISOString() : null });
        return stage;
      },
      complete2fa: () => {
        const { empId, policyAccepted } = get();
        const stage: SessionStage = empId && policyAccepted[empId] ? "signed_in" : "needs_first_login";
        set({ stage, signedInAt: stage === "signed_in" ? new Date().toISOString() : null });
        return stage;
      },
      completeFirstLogin: () => {
        const { empId, policyAccepted } = get();
        if (!empId) return;
        set({ stage: "signed_in", signedInAt: new Date().toISOString(), policyAccepted: { ...policyAccepted, [empId]: true } });
      },
      viewAs: (empId) =>
        set((s) => ({ empId, stage: "signed_in", policyAccepted: { ...s.policyAccepted, [empId]: true }, signedInAt: new Date().toISOString() })),
      applyServerStage: (empId, serverStage) => {
        const stage = STAGE_FROM_SERVER[serverStage];
        set({ empId, stage, signedInAt: stage === "signed_in" ? new Date().toISOString() : null });
        return stage;
      },
      signOutLocal: () => {
        setCsrf(null);
        set({ empId: null, liveMe: null, stage: "signed_out", signedInAt: null });
      },
      signOut: () => {
        // Live mode: end the session on the server first (every logout is recorded there).
        void import("@/lib/api/http").then(({ http, isLive }) => {
          if (isLive("m2")) void http.post("/auth/logout", {}).catch(() => undefined);
        });
        setCsrf(null);
        set({ empId: null, stage: "signed_out", signedInAt: null });
      },
      checkIn: () => {
        const { empId, checks } = get();
        if (!empId) return;
        // Live (m7): the server records the check-in with its own clock; every attendance view refreshes from it.
        if (liveAttendance()) return void liveCheck("in");
        set({ checks: { ...checks, [empId]: { date: isoDay(new Date()), in: new Date().toISOString() } } });
      },
      checkOut: () => {
        const { empId, checks } = get();
        if (!empId) return;
        if (liveAttendance()) return void liveCheck("out");
        const cur = checks[empId];
        if (!cur?.in) return;
        set({ checks: { ...checks, [empId]: { ...cur, out: new Date().toISOString() } } });
      },
      todayCheck: () => {
        const { empId, checks } = get();
        if (!empId) return undefined;
        const c = checks[empId];
        return c && c.date === isoDay(new Date()) ? c : undefined;
      },
    }),
    { name: "aceva-session" },
  ),
);
