"use client";
import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Tip } from "@/components/ui/overlays";
import { maskTail } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useStepUp } from "./dialogs";

/**
 * Masked sensitive value (spec §3.5.3): shows "•••• 4821"; with permission an eye button
 * reveals it for 30 s (optionally after step-up). Every reveal is logged.
 */
export function MaskedValue({
  value,
  canReveal,
  stepUp: needsStepUp,
  label = "value",
  display,
  onReveal,
  className,
}: {
  value: string;
  canReveal: boolean;
  stepUp?: boolean;
  label?: string;
  /** Custom masked display (e.g. for salaries "PKR ••••••"). */
  display?: string;
  /** Called after a successful reveal, so the module can log the sensitive view (plan §8). */
  onReveal?: () => void;
  className?: string;
}) {
  const [shown, setShown] = React.useState(false);
  const stepUp = useStepUp();

  React.useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(false), 30_000);
    return () => clearTimeout(t);
  }, [shown]);

  const reveal = async () => {
    if (shown) return setShown(false);
    if (needsStepUp && !(await stepUp({ action: `Show ${label}`, detail: "The value is shown for 30 seconds." }))) return;
    setShown(true);
    onReveal?.();
    toast(`Showing ${label} for 30 s`, { description: "This view is logged." });
  };

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="font-mono tabular">{shown ? value : (display ?? maskTail(value))}</span>
      {canReveal && (
        <Tip content={shown ? "Hide" : `Show ${label} (logged)`}>
          <button
            type="button"
            onClick={reveal}
            className="rounded p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label={shown ? `Hide ${label}` : `Show ${label}`}
          >
            {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </Tip>
      )}
    </span>
  );
}
