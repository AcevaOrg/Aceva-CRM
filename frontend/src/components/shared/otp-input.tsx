"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

/** Six single-digit boxes with auto-advance and paste support (2FA, step-up). */
export function OtpInput({
  value,
  onChange,
  length = 6,
  autoFocus,
  invalid,
  onComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  autoFocus?: boolean;
  invalid?: boolean;
  onComplete?: (v: string) => void;
}) {
  const refs = React.useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? "");

  const setAt = (i: number, d: string) => {
    const next = (value.padEnd(length, " ").slice(0, i) + d + value.padEnd(length, " ").slice(i + 1)).replace(/\s+$/, "");
    onChange(next);
    if (next.replace(/\s/g, "").length === length) onComplete?.(next);
  };

  return (
    <div className="flex gap-2" role="group" aria-label="6-digit code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          autoFocus={autoFocus && i === 0}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1}`}
          aria-invalid={invalid || undefined}
          maxLength={1}
          value={d.trim()}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "").slice(-1);
            if (!v) return;
            setAt(i, v);
            refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace") {
              e.preventDefault();
              if (d.trim()) setAt(i, " ");
              else if (i > 0) {
                setAt(i - 1, " ");
                refs.current[i - 1]?.focus();
              }
            }
            if (e.key === "ArrowLeft") refs.current[i - 1]?.focus();
            if (e.key === "ArrowRight") refs.current[i + 1]?.focus();
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
            if (!text) return;
            e.preventDefault();
            onChange(text);
            refs.current[Math.min(text.length, length - 1)]?.focus();
            if (text.length === length) onComplete?.(text);
          }}
          className={cn(
            "size-11 rounded-lg border border-input bg-card text-center font-mono text-lg font-semibold tabular shadow-[0_1px_1px_oklch(0.2_0.03_265/0.04)] transition focus:border-ring focus:outline-2 focus:outline-ring/30",
            invalid && "border-danger",
          )}
        />
      ))}
    </div>
  );
}
