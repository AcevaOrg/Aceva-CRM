/**
 * Client-side activity signals (plan §8, spec §4.6):
 *  - screen views: one event each time a screen opens
 *  - heartbeat: every 60 s, whether the mouse/keyboard was used that minute
 * Mock: kept in memory so Activity → "My activity" shows your own clicks live.
 * Live: POST /activity/screen and POST /activity/heartbeat.
 */
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
  liveHeartbeats().unshift({ empId, active, at: new Date().toISOString() });
}
