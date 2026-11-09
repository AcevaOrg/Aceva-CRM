import { Tip } from "@/components/ui/overlays";
import { formatMoney, formatMoneyCompact, toNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Currency, Money as MoneyT } from "@/types";

/** Monospace, tabular text for Emp-IDs, entry numbers, codes. */
export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono tabular text-[0.95em]", className)}>{children}</span>;
}

/**
 * Money: mono, tabular, currency always shown (spec §11).
 * `compact` for KPI cards (exact value in tooltip). `tone` colours negatives red only when asked.
 */
export function Money({
  value,
  currency,
  exact,
  compact,
  sign,
  tone,
  className,
}: {
  value: MoneyT | number;
  currency?: Currency;
  exact?: boolean;
  compact?: boolean;
  sign?: boolean;
  tone?: "auto" | "none";
  className?: string;
}) {
  const n = toNumber(value);
  const text = compact ? formatMoneyCompact(value, currency) : formatMoney(value, { currency, exact, sign });
  const cls = cn("font-mono tabular whitespace-nowrap", tone === "auto" && n < 0 && "text-danger", tone === "auto" && n > 0 && sign && "text-success", className);
  if (compact) {
    return (
      <Tip content={formatMoney(value, { currency, exact: true })}>
        <span className={cls} tabIndex={0}>
          {text}
        </span>
      </Tip>
    );
  }
  return <span className={cls}>{text}</span>;
}
