"use client";
import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Keep a value (tab, view, filter) in the URL so it survives reloads and can be shared.
 *   const [tab, setTab] = useUrlState("tab", "mine");
 */
export function useUrlState<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = (params.get(key) as T | null) ?? fallback;

  const set = useCallback(
    (v: T) => {
      const p = new URLSearchParams(params.toString());
      if (v === fallback) p.delete(key);
      else p.set(key, v);
      const qs = p.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [params, router, pathname, key, fallback],
  );

  return [value, set];
}
