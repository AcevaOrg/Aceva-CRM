"use client";
import { useEffect, useRef } from "react";

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/**
 * Keyboard shortcuts. Keys: "mod+k" (Ctrl/⌘), "?", or two-key sequences like "g h".
 */
export function useHotkeys(bindings: Record<string, (e: KeyboardEvent) => void>) {
  const ref = useRef(bindings);
  useEffect(() => {
    ref.current = bindings;
  });

  useEffect(() => {
    let prefix: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && ref.current[`mod+${key}`]) {
        e.preventDefault();
        ref.current[`mod+${key}`](e);
        return;
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (prefix) {
        const combo = `${prefix} ${key}`;
        prefix = null;
        clearTimeout(timer);
        if (ref.current[combo]) {
          e.preventDefault();
          ref.current[combo](e);
        }
        return;
      }
      if (Object.keys(ref.current).some((k) => k.startsWith(`${key} `))) {
        prefix = key;
        timer = setTimeout(() => (prefix = null), 900);
        return;
      }
      const single = e.key === "?" ? "?" : key;
      if (ref.current[single]) {
        e.preventDefault();
        ref.current[single](e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
