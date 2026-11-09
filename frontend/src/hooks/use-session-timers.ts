"use client";
/**
 * Session timers (plan §6, spec §4.6):
 *  - idle logout after 30 min (10 min on finance screens)
 *  - "still here" heartbeat every 60 s
 *  - one screen event per page open
 *
 * Input timestamps live in refs that are only touched in event handlers and effects;
 * the visible countdown is recomputed by an interval and stored in state.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/auth/session";
import { sendHeartbeat, trackScreen } from "@/lib/telemetry";
import { matchNav } from "@/lib/nav";

export const FINANCE_PREFIXES = ["/finance", "/payroll", "/billing"];

export function isFinanceRoute(pathname: string) {
  return FINANCE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

const IDLE_AFTER_MS = 5 * 60_000;

export function useSessionTimers() {
  const pathname = usePathname();
  const empId = useSession((s) => s.empId);
  const signOut = useSession((s) => s.signOut);
  const lastInput = useRef(0);
  const activeThisMinute = useRef(false);
  const limitMin = isFinanceRoute(pathname) ? 10 : 30;
  const [state, setState] = useState({ secondsLeft: limitMin * 60, isIdle: false });

  const compute = useCallback(() => {
    const idleMs = Date.now() - lastInput.current;
    setState({ secondsLeft: Math.max(0, Math.round((limitMin * 60_000 - idleMs) / 1000)), isIdle: idleMs > IDLE_AFTER_MS });
  }, [limitMin]);

  // Input listeners.
  useEffect(() => {
    lastInput.current = Date.now();
    const mark = () => {
      lastInput.current = Date.now();
      activeThisMinute.current = true;
    };
    const events = ["mousemove", "keydown", "pointerdown", "scroll", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, mark));
  }, []);

  // Countdown (every 5 s) + heartbeat (every 60 s).
  useEffect(() => {
    const tick = setInterval(compute, 5_000);
    const beat = setInterval(() => {
      if (empId) sendHeartbeat(empId, activeThisMinute.current);
      activeThisMinute.current = false;
    }, 60_000);
    return () => {
      clearInterval(tick);
      clearInterval(beat);
    };
  }, [empId, compute]);

  // Screen view events.
  useEffect(() => {
    if (empId) trackScreen(empId, matchNav(pathname)?.label ?? pathname);
  }, [pathname, empId]);

  // Time's up: end the session (an external store, not React state).
  useEffect(() => {
    if (state.secondsLeft === 0 && empId) signOut();
  }, [state.secondsLeft, empId, signOut]);

  const stay = useCallback(() => {
    lastInput.current = Date.now();
    compute();
  }, [compute]);

  return {
    secondsLeft: state.secondsLeft,
    limitMin,
    isIdle: state.isIdle,
    stay,
    warn: state.secondsLeft > 0 && state.secondsLeft <= 60,
  };
}
