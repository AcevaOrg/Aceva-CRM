/**
 * Client-side activity signals (plan §8, spec §4.6):
 *  - screen views: one event each time a screen opens
 *  - heartbeat: every 60 s, whether the mouse/keyboard was used that minute
 * Mock: kept in memory so Activity → "My activity" shows your own clicks live.
 * Live: POST /activity/screen and POST /activity/heartbeat.
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

export function trackScreen(empId: string, screen: string) {
  liveScreens().unshift({ empId, screen, at: new Date().toISOString() });
}

export function sendHeartbeat(empId: string, active: boolean) {
  // Live login (Module 2): a minute with real activity counts as activity for the server's idle timer.
  // A minute with no mouse or keyboard use sends nothing, so the idle limit keeps counting down.
  if (isLive("m2")) {
    if (active) void http.get("/auth/me").catch(() => undefined);
    return;
  }
  liveHeartbeats().unshift({ empId, active, at: new Date().toISOString() });
}
