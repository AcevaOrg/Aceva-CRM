import { isOpenDealStage } from '@aceva/contracts';
import type { ScopeService } from '../access/scope.service';
import { SALES_MANAGE } from './sales-access.service';
import type { Db } from './sales-errors';

const DIRECTOR_LEVEL = 2;
export const WON_EXCEPTION_BASIS = 'requester_left_no_confirmer';
export const SELF = 'self';

/** The deal fields the conditions read. */
interface DealForCheck {
  id: string;
  number: string;
  ownerId: string;
  stage: string;
  wonStatus: string;
  archivedAt: Date | null;
  wonRequestedById: string | null;
  wonRequestedAt: Date | null;
  owner: { level: { number: number } };
}

export interface WonExceptionCheck {
  /** Every condition holds. */
  ok: boolean;
  /** Why not, in plain words ("self" when the decider is the owner or the person who asked). */
  why: string;
  requester?: { id: string; empId: string };
  ownerAtRequest?: { id: string; empId: string };
  moves: Array<{ at: string; note: string | null }>;
  confirmersChecked: string[];
}

/**
 * The conditions of the exceptional Won decision (approved M15.5 follow-up), all of which must hold:
 *  1. the deal is open and its Won request pending;
 *  2. the decider is neither the deal's owner nor the person who asked;
 *  3. the person who asked has left (Module 3 offboarding);
 *  4. the deal is not one a Director owns (B1 decides those, unchanged);
 *  5. the deal was moved to someone else when someone left, after the request (deal history: owner_changed, employee_left);
 *  6. nobody can decide it the normal way: no active holder of the sales-manager permission (other than the owner and the
 *     person who asked) has the current owner in their reporting line.
 * Read-only; callers run it inside their transaction under the deal's row lock when they act on it.
 */
export async function checkWonException(db: Db, scope: ScopeService, deal: DealForCheck, deciderId: string): Promise<WonExceptionCheck> {
  const base = { moves: [], confirmersChecked: [] };
  if (deal.wonStatus !== 'pending' || !isOpenDealStage(deal.stage as never) || deal.archivedAt || !deal.wonRequestedById || !deal.wonRequestedAt) {
    return { ...base, ok: false, why: 'This deal is not waiting for a Won confirmation' };
  }
  if (deciderId === deal.ownerId || deciderId === deal.wonRequestedById) return { ...base, ok: false, why: SELF };
  const requester = await db.employee.findUnique({ where: { id: deal.wonRequestedById }, select: { id: true, empId: true, status: true } });
  if (!requester || requester.status !== 'left') return { ...base, ok: false, why: 'The person who asked for Won has not left: they or their sales manager decide it the normal way' };
  if (deal.owner.level.number === DIRECTOR_LEVEL) return { ...base, ok: false, why: 'A deal the Director owns is confirmed through the normal route (decision B1)' };
  const moves = await db.salesDealHistory.findMany({
    where: { dealId: deal.id, event: 'owner_changed', reason: 'employee_left', at: { gte: deal.wonRequestedAt } },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
    select: { at: true, note: true },
  });
  if (!moves.length) return { ...base, ok: false, why: 'The deal was not moved to someone else when the person who asked left' };
  // Who owned the deal when Won was asked: the leaver whose move came first after the request (the offboarding summary).
  const firstMove = await db.auditLog.findFirst({
    where: { action: 'sales.offboarding.reassigned', occurredAt: { gte: deal.wonRequestedAt }, details: { path: ['deals'], array_contains: [deal.number] } },
    orderBy: { occurredAt: 'asc' },
    select: { targetId: true },
  });
  const ownerAtRequest = firstMove?.targetId ? await db.employee.findUnique({ where: { empId: firstMove.targetId }, select: { id: true, empId: true } }) : null;
  if (!ownerAtRequest) return { ...base, ok: false, why: 'The record of the move when the person who asked left was not found' };
  const holders = await db.$queryRaw<Array<{ id: string; empId: string }>>`
    SELECT DISTINCT e.id, e.emp_id AS "empId" FROM employees e
    WHERE e.status = 'active' AND e.id <> ${deal.ownerId}::uuid AND e.id <> ${deal.wonRequestedById}::uuid AND (
      EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = e.role_id AND p.key = ${SALES_MANAGE})
      OR EXISTS (SELECT 1 FROM employee_duties ed JOIN duty_permissions dp ON dp.duty_id = ed.duty_id JOIN permissions p ON p.id = dp.permission_id
                 WHERE ed.employee_id = e.id AND ed.ended_at IS NULL AND p.key = ${SALES_MANAGE}))
    ORDER BY "empId"`;
  const able: string[] = [];
  for (const h of holders) if (await scope.canAccess(h.id, deal.ownerId)) able.push(h.empId);
  const out = { moves: moves.map((m) => ({ at: m.at.toISOString(), note: m.note })), confirmersChecked: holders.map((h) => h.empId), requester: { id: requester.id, empId: requester.empId }, ownerAtRequest };
  if (able.length) return { ...out, ok: false, why: `${able.join(', ')} can decide it the normal way` };
  return { ...out, ok: true, why: '' };
}
