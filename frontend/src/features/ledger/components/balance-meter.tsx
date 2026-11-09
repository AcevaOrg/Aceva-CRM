"use client";
import { CircleCheck, Scale } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Currency } from "@/types";

/**
 * Balance meter (spec §3.5.7): a beam that tilts toward the heavier side as lines are typed,
 * shows the difference, and levels out green when debits equal credits.
 */
export function BalanceMeter({ debit, credit, currency, className }: { debit: number; credit: number; currency: Currency; className?: string }) {
  const diff = Math.round((debit - credit) * 100) / 100;
  const balanced = Math.abs(diff) < 0.005 && debit > 0;
  const empty = debit === 0 && credit === 0;
  const total = Math.max(debit, credit, 1);
  // Debits sit on the left: heavier debits push the left pan down (counter-clockwise).
  const angle = balanced || empty ? 0 : -Math.sign(diff) * Math.min(9, 2.5 + (Math.abs(diff) / total) * 12);
  const message = empty ? "Add lines to start" : balanced ? "Balanced" : diff > 0 ? `Credits short by ${formatMoney(Math.abs(diff), { currency, exact: true })}` : `Debits short by ${formatMoney(Math.abs(diff), { currency, exact: true })}`;

  return (
    <div className={cn("flex items-center gap-4", className)} role="status" aria-live="polite" aria-label={`Debits ${debit.toFixed(2)}, credits ${credit.toFixed(2)}. ${message}`}>
      <div className="relative h-14 w-44 shrink-0" aria-hidden>
        {/* fulcrum */}
        <div className={cn("absolute bottom-0 left-1/2 h-0 w-0 -translate-x-1/2 border-x-[9px] border-b-[14px] border-x-transparent transition-colors", balanced ? "border-b-success" : "border-b-muted-foreground/40")} />
        {/* beam */}
        <div className="absolute inset-x-1 top-5 transition-transform duration-300 ease-out" style={{ transform: `rotate(${angle}deg)` }}>
          <div className={cn("h-[3px] rounded-full transition-colors", balanced ? "bg-success" : "bg-foreground/70")} />
          <span className="absolute -left-1 top-1 flex flex-col items-center">
            <span className="h-2.5 w-px bg-foreground/40" />
            <span className={cn("h-1.5 w-9 rounded-b-full transition-colors", balanced ? "bg-success/70" : diff > 0 ? "bg-zone-finance" : "bg-zone-finance/40")} />
          </span>
          <span className="absolute -right-1 top-1 flex flex-col items-center">
            <span className="h-2.5 w-px bg-foreground/40" />
            <span className={cn("h-1.5 w-9 rounded-b-full transition-colors", balanced ? "bg-success/70" : diff < 0 ? "bg-zone-finance" : "bg-zone-finance/40")} />
          </span>
        </div>
        <span className="absolute -bottom-0.5 left-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Dr</span>
        <span className="absolute -bottom-0.5 right-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Cr</span>
      </div>
      <div className="grid min-w-0 gap-0.5">
        <p className={cn("flex items-center gap-1.5 text-[13.5px] font-semibold", balanced ? "text-success" : empty ? "text-muted-foreground" : "text-foreground")}>
          {balanced ? <CircleCheck className="size-4" /> : <Scale className="size-4 text-muted-foreground" />}
          {message}
        </p>
        <p className="font-mono text-[12px] text-muted-foreground tabular">
          Dr {formatMoney(debit, { currency, exact: true })} · Cr {formatMoney(credit, { currency, exact: true })}
        </p>
      </div>
    </div>
  );
}
