"use client";
/**
 * A shared ticking clock as an external store, so components can show "time ago",
 * elapsed time or countdowns without calling Date.now() during render.
 *
 *   const now = useNow(60_000); // re-renders at most once a minute
 *
 * Returns 0 on the server and during hydration; treat 0 as "not known yet".
 */
import { useCallback, useSyncExternalStore } from "react";

let current = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Current time in ms, rounded down to `resolutionMs` so callers only re-render when the bucket changes. */
export function useNow(resolutionMs = 1000) {
  const getSnapshot = useCallback(() => (current ? Math.floor(current / resolutionMs) * resolutionMs : 0), [resolutionMs]);
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
