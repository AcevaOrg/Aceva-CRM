"use client";
import { useSyncExternalStore } from "react";
import { useSession } from "@/lib/auth/session";

const subscribe = (cb: () => void) => useSession.persist.onFinishHydration(cb);
const getSnapshot = () => useSession.persist.hasHydrated();
const getServerSnapshot = () => false;

/** True once the persisted session has loaded from localStorage. */
export function useHydrated() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
