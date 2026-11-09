import { CircleCheck, CircleX, ShieldCheck, ShieldX } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatStatementAmount } from "@/features/ledger/components/ledger-bits";
import type { StatementCheck } from "../types";

/**
 * Self-check strip (spec §3.5.8): each built-in check with both numbers.
 * Any failure turns the strip red and blocks "Mark final".
 */
export function SelfCheck({ checks, currency }: { checks: StatementCheck[]; currency: string }) {
  if (!checks.length) return null;
  const ok = checks.every((c) => c.pass);
  return (
    <section
      aria-label="Built-in checks"
      className={cn("grid gap-2 rounded-xl border px-4 py-3", ok ? "border-success/30 bg-success/6" : "border-danger/35 bg-danger/8")}
    >
      <p className="flex items-center gap-2 text-[13px] font-semibold">
        {ok ? <ShieldCheck className="size-4 text-success" /> : <ShieldX className="size-4 text-danger" />}
        {ok ? "Every built-in check passes" : "A built-in check failed. This statement can't be marked final until it is fixed."}
      </p>
      <ul className="grid gap-1.5">
        {checks.map((c) => (
          <li key={c.label} className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 text-[12.5px]">
            {c.pass ? <CircleCheck className="mt-0.5 size-4 text-success" aria-label="Pass" /> : <CircleX className="mt-0.5 size-4 text-danger" aria-label="Fail" />}
            <span className="font-medium">{c.label}</span>
            <span className="col-start-2 font-mono text-[12px] text-muted-foreground tabular">
              {c.left.label} {currency} {formatStatementAmount(c.left.amount)} {c.pass ? "=" : "≠"} {c.right.label} {currency} {formatStatementAmount(c.right.amount)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
