import type { Prisma } from '../generated/prisma/client';
import type { Db } from './sales-errors';
import type { SalesMetricsService } from './sales-metrics.service';

type Tx = Prisma.TransactionClient;

/**
 * Module 15.7 commission eligibility (approved scope, corrected): fixed ONCE per Won deal and never re-judged.
 *  - At the Won confirmation (from the M15.7 baseline on): the deal owner is eligible when they are sales staff under the
 *    M15.6 rule (the Sales department with sales.own, or a sales manager), counting people on notice as still employed,
 *    and never the Owner role.
 *  - A deal confirmed before the baseline (no snapshot yet) gets a LEGACY snapshot, judged at the moment the baseline is
 *    recorded, in the same transaction.
 * A later department, role or status change never removes or adds commission. Whether the earner has LEFT is a separate
 * question, asked when the commission is calculated (a leaver's line is held for the Owner).
 */
export const COMMISSION_EMPLOYED_STATUSES = ['active', 'on_notice'] as const;

/** Serialises the baseline recording with every Won confirmation, so no confirmed deal is ever left without a snapshot. */
export async function lockCommissionBaseline(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('sales_commission_baseline', 0))`;
}

export async function commissionBaseline(db: Db): Promise<{ baselineAt: Date; businessDay: Date } | null> {
  return db.salesCommissionBaseline.findUnique({ where: { id: 1 }, select: { baselineAt: true, businessDay: true } });
}

/** What the rule sees for one person now (recorded on the snapshot). */
export async function judgeEligibility(db: Db, metrics: SalesMetricsService, employeeId: string): Promise<{ eligible: boolean; departmentCode: string; roleKey: string; status: string }> {
  const e = await db.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { status: true, role: { select: { key: true } }, department: { select: { code: true } } } });
  const staff = e.role.key !== 'owner' && (await metrics.salespeople(db, { id: employeeId }, COMMISSION_EMPLOYED_STATUSES)).length > 0;
  return { eligible: staff, departmentCode: e.department.code, roleKey: e.role.key, status: e.status };
}

/**
 * Called by DealsService.applyConfirm inside the confirmation's transaction: from the baseline on, the deal's eligibility
 * snapshot is written with the confirmation itself (before it, the baseline recording writes a legacy snapshot).
 */
export async function snapshotAtWonConfirmation(tx: Tx, metrics: SalesMetricsService, deal: { id: string; ownerId: string }, at: Date): Promise<void> {
  await lockCommissionBaseline(tx);
  if (!(await commissionBaseline(tx))) return;
  if (await tx.salesCommissionEligibility.findUnique({ where: { dealId: deal.id }, select: { id: true } })) return;
  const j = await judgeEligibility(tx, metrics, deal.ownerId);
  await tx.salesCommissionEligibility.create({ data: { dealId: deal.id, earnerId: deal.ownerId, basis: 'won_confirmation', evaluatedAt: at, ...j } });
}
