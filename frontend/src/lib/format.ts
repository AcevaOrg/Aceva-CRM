import type { Currency, Money } from "@/types";

const LOCALE = "en-PK";

/** Parse a decimal money string into a number for display/calculation in the UI only. */
export function toNumber(m: Money | string | number): number {
  if (typeof m === "number") return m;
  if (typeof m === "string") return Number(m);
  return Number(m.amount);
}

export function money(amount: number, currency: Currency = "PKR"): Money {
  return { amount: amount.toFixed(2), currency };
}

/** "PKR 125,000" or "USD 1,250.50". `exact` always shows 2 decimals (ledgers, statements). */
export function formatMoney(m: Money | number, opts: { currency?: Currency; exact?: boolean; sign?: boolean } = {}) {
  const value = toNumber(typeof m === "number" ? m : m);
  const currency = typeof m === "number" ? (opts.currency ?? "PKR") : m.currency;
  const decimals = opts.exact || currency === "USD" ? 2 : Number.isInteger(value) ? 0 : 2;
  const abs = Math.abs(value).toLocaleString(LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const sign = value < 0 ? "−" : opts.sign && value > 0 ? "+" : "";
  return `${sign}${currency} ${abs}`;
}

/** Compact for KPI cards: "PKR 4.8M". Always pair with the exact value in a tooltip. */
export function formatMoneyCompact(m: Money | number, currency: Currency = "PKR") {
  const value = toNumber(m);
  const cur = typeof m === "number" ? currency : m.currency;
  const abs = Math.abs(value);
  const fmt = (n: number, suffix: string) => `${n.toFixed(n >= 100 ? 0 : 1).replace(/\.0$/, "")}${suffix}`;
  let body: string;
  if (abs >= 1_000_000_000) body = fmt(abs / 1_000_000_000, "B");
  else if (abs >= 1_000_000) body = fmt(abs / 1_000_000, "M");
  else if (abs >= 1_000) body = fmt(abs / 1_000, "K");
  else body = abs.toFixed(0);
  return `${value < 0 ? "−" : ""}${cur} ${body}`;
}

export function formatNumber(n: number, decimals = 0) {
  return n.toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatPercent(n: number, decimals = 0) {
  return `${n.toFixed(decimals)}%`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Show only the last 4 characters: "•••• 4821" (spec §3.5.3). */
export function maskTail(value: string, visible = 4) {
  const clean = value.replace(/\s|-/g, "");
  return `•••• ${clean.slice(-visible)}`;
}

/** Normalise user input "7", "0007", "acv-0007" → "ACV-0007". */
export function normalizeEmpId(input: string) {
  const digits = input.replace(/\D/g, "").slice(-4);
  return digits ? `ACV-${digits.padStart(4, "0")}` : "";
}

export function minutesToHours(min: number) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
