import type { BillingPeriod } from '../generated/prisma/client';

/** Calendar helpers on Pakistan days ('YYYY-MM-DD'). */

const MONTHS: Record<BillingPeriod | 'usage', number> = { monthly: 1, quarterly: 3, yearly: 12, usage: 1 };

/** The same day n months later; a day that does not exist in that month becomes its last day (31 Jan + 1 = 28/29 Feb). */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** The start of the next period. */
export function nextPeriodStart(day: string, period: BillingPeriod | 'usage'): string {
  return addMonths(day, MONTHS[period]);
}

/**
 * The start of the period after `current`, counted from the rule's first day so month ends do not drift
 * (31 Jan, 28 Feb, 31 Mar...).
 */
export function periodAfter(ruleStart: string, current: string, period: BillingPeriod | 'usage'): string {
  for (let k = 1; k < 1200; k++) {
    const d = addMonths(ruleStart, MONTHS[period] * k);
    if (d > current) return d;
  }
  throw new Error('Period out of range');
}

/** Whole days from a to b (b - a). */
export function daysDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function minDay(a: string, b: string): string {
  return a < b ? a : b;
}
