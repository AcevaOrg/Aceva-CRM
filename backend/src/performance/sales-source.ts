/**
 * Where the sales numbers behind a SALES scorecard come from (plan section 10 and section 20): the days the daily sales
 * targets were met, meetings booked, value of deals won, bounce rate and duplicate leads, which Module 15 (sales and
 * CRM, Phase 2) will provide. Until it exists the stand-in says "not available".
 *
 * THE STAND-IN NEVER INVENTS A NUMBER. (The mock screens fabricate hash-based sales numbers; the server never copies that.)
 * It answers `{ available: false }`; a sales scorecard is then still made every month for every salesperson, but with
 * no V, M, W, D figures and NO SCORE and no band (attendance alone says nothing about sales work). The metrics are null
 * and named in `unmeasured` with the reason `sales_not_available`; the screens say "Sales figures arrive with the Sales
 * module". Sales staff are never scored from their tasks (plan section 10: most of their work happens outside the task
 * list). Nothing to undo when Module 15 arrives: new scorecards use the figures.
 *
 * HOW MODULE 15 PLUGS IN: write a class that implements SalesSource and replace the provider in performance.module.ts:
 * `{ provide: SALES_SOURCE, useClass: Module15SalesSource }`. Nothing else changes.
 *
 * WHAT AN IMPLEMENTATION MUST KEEP TO (the monthly job and the live figures both rely on it):
 *  - Answer `{ available: false }` when the person has no sales figures for the month (never zeros standing in for "no data").
 *    A real month in which the person did nothing is `available: true` with real zeros.
 *  - The detail holds the raw numbers (days the daily target was met, working days, meetings and their target, value won and its
 *    target, bounce rate in percent, duplicate leads); the scorecard works V, M, W and D out of them with rules/perf-tasks.ts
 *    salesMetrics, so a source never computes a metric itself and never returns a score.
 *  - Throw only for a real fault (the CRM cannot be read): the monthly job then counts that person as failed and retries, so a
 *    temporary fault is never stored as "not available".
 *  - The month is a Pakistan month ("2026-10").
 */
import type { SalesDetail } from './rules/perf-tasks';

export type SalesFigure = { available: true; detail: SalesDetail } | { available: false };

export interface SalesSource {
  /** The sales numbers of the person (internal employee id) for a month ("2026-10", Pakistan month), or `{ available: false }`. */
  figuresFor(employeeId: string, month: string): Promise<SalesFigure>;
}

/** Injection token for the sales source. */
export const SALES_SOURCE = Symbol('SALES_SOURCE');

/** The stand-in until Module 15 exists: no figures for anybody. */
export class NotBuiltSalesSource implements SalesSource {
  async figuresFor(): Promise<SalesFigure> {
    return { available: false };
  }
}
