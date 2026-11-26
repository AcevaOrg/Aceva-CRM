/**
 * Client-side activity signals (plan §8, spec §4.6):
 *  - screen views: one event each time a screen opens
 *  - heartbeat: every 60 s, whether the mouse/keyboard was used that minute (nothing else: no keys, no screen content)
 * Mock: kept in memory so Activity → "My activity" shows your own clicks live.
 * Live (Module 4 on the server, NEXT_PUBLIC_LIVE_MODULES contains m4): POST /activity/screen and POST /activity/heartbeat.
 */
import { http, isLive } from "@/lib/api/http";
import { table } from "@/mocks/db";

export interface LiveScreenEvent {
  empId: string;
  at: string;
  screen: string;
}

export interface LiveHeartbeat {
  empId: string;
  at: string;
  active: boolean;
}

export const liveScreens = () => table<LiveScreenEvent>("telemetry.screens", () => []);
export const liveHeartbeats = () => table<LiveHeartbeat>("telemetry.heartbeats", () => []);

/** One screen was opened: its label (what people see) and the page path. */
export function trackScreen(empId: string, screen: string, path?: string) {
  if (isLive("m4")) {
    const page = path && path.startsWith("/") ? path.split(/[?#]/)[0].slice(0, 300) : undefined;
    void http.post("/activity/screen", { screen: screen.slice(0, 120) || "Page", ...(page ? { path: page } : {}) }).catch(() => undefined);
    return;
  }
  liveScreens().unshift({ empId, screen, at: new Date().toISOString() });
}

export function sendHeartbeat(empId: string, active: boolean, financeScreen = false) {
  // On a finance screen the heartbeat says so (X-Aceva-Screen: finance): the session keeps the 10-minute finance limit,
  // also for its live socket (Module 14). The header can only make the limit stricter.
  const screen = financeScreen ? { "X-Aceva-Screen": "finance" } : undefined;
  // Live tracking (Module 4): every minute, used or not. The server counts only a used minute as activity for the idle
  // timer, so an open but unused tab still times out after 30 minutes.
  if (isLive("m4")) {
    void http.post("/activity/heartbeat", { active }, screen).catch(() => undefined);
    return;
  }
  // Live login only (Module 2): a minute with real activity counts as activity for the server's idle timer.
  // A minute with no mouse or keyboard use sends nothing, so the idle limit keeps counting down.
  if (isLive("m2")) {
    if (active) void http.get("/auth/me", undefined, screen).catch(() => undefined);
    return;
  }
  liveHeartbeats().unshift({ empId, active, at: new Date().toISOString() });
}
