"use client";
/**
 * Client session (mock mode). In live mode the server owns the session through an
 * HTTP-only cookie and this store only caches who is signed in (spec §9.2).
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isoDay } from "@/lib/dates";

export type SessionStage = "signed_out" | "needs_2fa" | "needs_first_login" | "signed_in";

interface DayCheck {
  date: string;
  in?: string;
  out?: string;
}

interface SessionState {
  empId: string | null;
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
  signOut: () => void;
  checkIn: () => void;
  checkOut: () => void;
  todayCheck: () => DayCheck | undefined;
}

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      empId: null,
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
      signOut: () => set({ empId: null, stage: "signed_out", signedInAt: null }),
      checkIn: () => {
        const { empId, checks } = get();
        if (!empId) return;
        set({ checks: { ...checks, [empId]: { date: isoDay(new Date()), in: new Date().toISOString() } } });
      },
      checkOut: () => {
        const { empId, checks } = get();
        if (!empId) return;
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
