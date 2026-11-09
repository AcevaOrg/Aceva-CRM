"use client";
import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Tip } from "@/components/ui/overlays";
import { useStepUp } from "@/components/shared/dialogs";
import { maskTail } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Like the shared MaskedValue (spec §3.5.3), plus an onReveal callback so the reveal is
 * logged as a sensitive view (POST /employees/:empId/reveal).
 */
export function LoggedMaskedValue({
  value,
  canReveal,
  stepUp: needsStepUp,
  label,
  display,
  onReveal,
  className,
}: {
  value: string;
  canReveal: boolean;
  stepUp?: boolean;
  label: string;
  display?: string;
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

  if (!value) return <span className="text-muted-foreground">Not added yet</span>;

  const reveal = async () => {
    if (shown) return setShown(false);
    if (needsStepUp && !(await stepUp({ action: `Show ${label}`, detail: "Shown for 30 seconds. The view is logged." }))) return;
    onReveal?.();
    setShown(true);
    toast(`Showing ${label} for 30 s`, { description: "This view is logged." });
  };

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="font-mono tabular">{shown ? value : (display ?? maskTail(value))}</span>
      {canReveal && (
        <Tip content={shown ? "Hide" : `Show ${label} (logged)`}>
          <button type="button" onClick={reveal} className="rounded p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label={shown ? `Hide ${label}` : `Show ${label}`}>
            {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </Tip>
      )}
    </span>
  );
}
