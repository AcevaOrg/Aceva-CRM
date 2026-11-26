import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  type Currency,
  type OutboxEvent,
  SALES_COMMISSION_STATUSES,
  type SalesCommissionLineView,
  type SalesCommissionListQuery,
  type SalesCommissionListView,
  type SalesCommissionRuleView,
  type SalesCommissionRulesView,
  type SalesCommissionStatus,
  type SalesCommissionTotals,
  type SetSalesCommissionRuleRequest,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { StepUpService } from '../auth/step-up.service';
import { Clock } from '../common/clock';
import { dec, round2, ZERO } from '../common/money';
import { addDays, dayOf, dbDate, monthOf, pkDate, pkInstant } from '../common/pakistan-time';
import { noteActivity } from '../common/request-context';
import { ENV } from '../config/config.module';
import { backgroundWorkersOn, type Env } from '../config/env';
import { OutboxConsumerRunner } from '../events/outbox-consumer-runner.service';
import { OutboxService } from '../events/outbox.service';
import type { Prisma } from '../generated/prisma/client';
import { JobRunner } from '../jobs/job-runner.service';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { commissionBaseline, judgeEligibility, lockCommissionBaseline } from './commission-eligibility';
import { SalesAccessService } from './sales-access.service';
import { badRequest, conflict, type Db, forbidden, notFound } from './sales-errors';
import { SalesMetricsService } from './sales-metrics.service';
import { person } from './sales-views';

type Tx = Prisma.TransactionClient;

/** The reader's name in outbox_consumers. Never rename it. */
export const SALES_COMMISSION_CONSUMER = 'sales-commission';
/** The daily reconciliation (a missed "invoice paid" event never loses a commission). */
export const SALES_COMMISSION_RECONCILE_JOB = 'sales.commission_reconcile';
const RECONCILE_MINUTE = 60; // 01:00 Pakistan time
/** Finance, the Director and the Owner see every commission line (plan section 20). */
export const COMMISSION_VIEW = 'sales.commission_view';
/** The Director: approves or rejects normal commission lines and sets the commission rule. */
export const COMMISSION_APPROVE = 'sales.commission_approve';
/** The Owner (approved M15.7): the Director's own lines, and lines held because the earner left. Always with step-up. */
export const COMMISSION_APPROVE_DIRECTOR = 'sales.commission_approve_director';
/** The Director and the Finance duty (approved M15.7): hold or reject a normal line by hand, for example after a refund. */
export const COMMISSION_HOLD = 'sales.commission_hold';

const COMMISSION_LINK = '/sales/targets?tab=commission';

const lineInclude = {
  deal: { select: { id: true, number: true, company: { select: { name: true } } } },
  invoice: { select: { number: true } },
  earner: { select: { id: true, empId: true, fullName: true, status: true } },
  wonOwner: { select: { empId: true, fullName: true } },
  eligibility: { select: { basis: true, evaluatedAt: true } },
  heldBy: { select: { empId: true, fullName: true } },
  approvedBy: { select: { empId: true, fullName: true } },
  rejectedBy: { select: { empId: true, fullName: true } },
  leaverDecidedBy: { select: { empId: true, fullName: true } },
  events: { orderBy: { at: 'asc' }, include: { actor: { select: { empId: true, fullName: true } } } },
} satisfies Prisma.SalesCommissionLineInclude;
type LineRow = Prisma.SalesCommissionLineGetPayload<{ include: typeof lineInclude }>;
type RuleRow = Prisma.SalesCommissionRuleGetPayload<{ include: { setBy: { select: { empId: true; fullName: true } } } }>;
type Plain = Prisma.SalesCommissionLineGetPayload<object>;

/** What the viewer may do: computed once per request. */
interface Powers {
  actor: Actor;
  approve: boolean;
  approveDirector: boolean;
  hold: boolean;
}

/** The commission formula (approved): PKR base x rate / 100, rounded half up to 2 decimals (also a database CHECK). */
export function commissionAmount(basePkr: Prisma.Decimal | string, ratePercent: Prisma.Decimal | string): Prisma.Decimal {
  return round2(dec(basePkr).times(dec(ratePercent)).dividedBy(100));
}

/**
 * What an invoice collected, from its posted payment allocations (approved M15.7 rule): the sum in the invoice's currency,
 * the same in PKR with each allocation at its own payment's recorded exchange rate (rounded half up per allocation), and
 * WHEN it became fully paid: the posting moment (journal_entries.posted_at) of the payment that completed it, taken in
 * posting order. Never the moment an event was handled, and never the payment's own (backdatable) date.
 */
export async function collectedValue(db: Db, invoiceId: string, total: Prisma.Decimal): Promise<{ collected: Prisma.Decimal; pkr: Prisma.Decimal; fullyPaidAt: Date | null }> {
  const rows = await db.paymentAllocation.findMany({
    where: { invoiceId },
    select: { amount: true, createdAt: true, payment: { select: { exchangeRate: true, journalEntryId: true, direction: true } } },
  });
  const entryIds = [...new Set(rows.map((r) => r.payment.journalEntryId).filter((x): x is string => !!x))];
  const posted = new Map(
    (entryIds.length ? await db.journalEntry.findMany({ where: { id: { in: entryIds }, status: 'posted', postedAt: { not: null } }, select: { id: true, postedAt: true } }) : []).map((e) => [e.id, e.postedAt!]),
  );
  const counted = rows
    .filter((r) => r.payment.direction === 'received' && r.payment.journalEntryId && posted.has(r.payment.journalEntryId))
    .map((r) => ({ ...r, postedAt: posted.get(r.payment.journalEntryId!)! }))
    .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
  let collected = ZERO;
  let pkr = ZERO;
  let fullyPaidAt: Date | null = null;
  for (const r of counted) {
    collected = collected.plus(r.amount);
    pkr = pkr.plus(round2(dec(r.amount).times(r.payment.exchangeRate)));
    if (!fullyPaidAt && collected.gte(total)) fullyPaidAt = r.postedAt;
  }
  return { collected, pkr, fullyPaidAt };
}

/**
 * Module 15.7, sales commission (plan section 20; the approved and corrected M15.7 scope, see packages/contracts/src/sales.ts).
 *
 * The baseline (sales_commission_baseline, one immutable row) is the internal eligibility boundary: only invoices whose
 * completing payment was POSTED at or after it can earn commission (also a database trigger). It is recorded once, when the
 * background workers first start with this module (or explicitly, recordBaseline); deals confirmed Won before it get a
 * legacy eligibility snapshot in the same transaction.
 *
 * Sources: the Module 13 event billing.invoice.paid for a deal's OWN invoice, and the daily reconciliation, which finds any
 * fully paid deal invoice still without a line. Both use one path: one line per deal, invoice and event (unique), made under
 * the deal's lock, so repeats and concurrent runs make nothing twice. No ledger writes; nothing here marks a line as
 * included in payroll (the separate Module 8 change does).
 */
@Injectable()
export class SalesCommissionService implements OnModuleInit {
  private readonly logger = new Logger('SalesCommission');

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: OutboxConsumerRunner,
    private readonly outbox: OutboxService,
    private readonly permissions: PermissionService,
    private readonly access: SalesAccessService,
    private readonly scope: ScopeService,
    private readonly metrics: SalesMetricsService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly stepUp: StepUpService,
    private readonly jobs: JobRunner,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.jobs.register(SALES_COMMISSION_RECONCILE_JOB, async (payload) => {
      const day = String(payload.day);
      await this.reconcile();
      await this.scheduleReconcile(addDays(day, 1));
    });
  }

  async onModuleInit(): Promise<void> {
    this.runner.register({ name: SALES_COMMISSION_CONSUMER, types: ['billing.invoice.paid'], handle: (event, tx) => this.onInvoicePaid(event, tx) });
    if (!backgroundWorkersOn(this.env)) return; // tests record the baseline and reconcile themselves
    try {
      await this.recordBaseline();
      await this.scheduleReconcile(pkDate(this.clock.now()), true);
    } catch (e) {
      this.logger.error(`Could not start commission work: ${(e as Error).message}`);
    }
  }

  async scheduleReconcile(day: string, keepExisting = false): Promise<void> {
    const runAt = pkInstant(day, RECONCILE_MINUTE);
    const dedupeKey = `${SALES_COMMISSION_RECONCILE_JOB}:${day}`;
    if (keepExisting) {
      await this.prisma.scheduledJob.createMany({ data: [{ type: SALES_COMMISSION_RECONCILE_JOB, dedupeKey, runAt, payload: { day } }], skipDuplicates: true });
      return;
    }
    if (await this.prisma.scheduledJob.findUnique({ where: { dedupeKey }, select: { id: true } })) return;
    await this.jobs.schedule(SALES_COMMISSION_RECONCILE_JOB, dedupeKey, runAt, { day }, null);
  }

  // =========================================================================================================== baseline

  /**
   * Records the one baseline (idempotent: an existing one is returned unchanged; the row can never change). In the same
   * transaction, every deal already confirmed Won without a snapshot gets a LEGACY snapshot judged now.
   */
  async recordBaseline(): Promise<{ baselineAt: Date; businessDay: string; legacySnapshots: number }> {
    return this.prisma.$transaction(async (tx) => {
      await lockCommissionBaseline(tx);
      const existing = await commissionBaseline(tx);
      if (existing) return { baselineAt: existing.baselineAt, businessDay: dayOf(existing.businessDay), legacySnapshots: 0 };
      const at = this.clock.now();
      const businessDay = pkDate(at);
      await tx.salesCommissionBaseline.create({ data: { id: 1, baselineAt: at, businessDay: dbDate(businessDay) } });
      const legacy = await tx.salesDeal.findMany({ where: { wonStatus: 'confirmed', commissionEligibility: { is: null } }, select: { id: true, number: true, ownerId: true }, orderBy: { number: 'asc' } });
      for (const d of legacy) {
        const j = await judgeEligibility(tx, this.metrics, d.ownerId);
        await tx.salesCommissionEligibility.create({ data: { dealId: d.id, earnerId: d.ownerId, basis: 'legacy_baseline', evaluatedAt: at, ...j } });
      }
      await this.audit.record({ actorId: null, action: 'sales.commission.baseline_recorded', targetType: 'sales_commission_baseline', targetId: '1', details: { baselineAt: at.toISOString(), businessDay, legacySnapshots: legacy.length } }, tx);
      return { baselineAt: at, businessDay, legacySnapshots: legacy.length };
    });
  }

  // ============================================================================================================ sources

  async onInvoicePaid(event: OutboxEvent, tx: Tx): Promise<void> {
    if (event.type !== 'billing.invoice.paid') return;
    const p = event.payload;
    if (!p.sourceDealNumber) return; // not a deal's own invoice: no commission (approved scope)
    const inv = await tx.invoice.findUnique({ where: { number: p.invoiceNumber }, select: { id: true } });
    if (!inv) return;
    await this.recordFor(tx, inv.id, { source: 'event', eventId: event.id });
  }

  /**
   * The daily reconciliation: every deal's own issued invoice without a line is checked again with the same rules (a
   * missed or failed event, a reader that started late). Idempotent: a second run, or a run at the same moment as the
   * reader, makes nothing twice. A skip is audited once per invoice and reason.
   */
  async reconcile(): Promise<{ checked: number; recorded: number }> {
    const candidates = await this.prisma.invoice.findMany({
      where: { sourceDealNumber: { not: null }, status: 'issued', salesCommissionLine: { is: null } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    let recorded = 0;
    for (const c of candidates) {
      const made = await this.prisma.$transaction((tx) => this.recordFor(tx, c.id, { source: 'reconciliation', eventId: null }));
      if (made) recorded++;
    }
    if (recorded) this.logger.log(`Reconciliation recorded ${recorded} commission line(s)`);
    return { checked: candidates.length, recorded };
  }

  /** The one path from a fully paid deal invoice to a line. Returns true when a line was made now. */
  private async recordFor(tx: Tx, invoiceId: string, from: { source: 'event' | 'reconciliation'; eventId: string | null }): Promise<boolean> {
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, number: true, currency: true, total: true, status: true, sourceDealNumber: true } });
    if (!inv?.sourceDealNumber || inv.status !== 'issued') return false;
    const deal = await tx.salesDeal.findUnique({ where: { number: inv.sourceDealNumber }, select: { id: true, number: true, wonStatus: true } });
    if (!deal) return false;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sales_commission:${deal.id}`}, 0))`;
    if (await tx.salesCommissionLine.findFirst({ where: { OR: [{ dealId: deal.id }, { invoiceId: inv.id }, ...(from.eventId ? [{ paidEventId: from.eventId }] : [])] }, select: { id: true } })) return false;
    const skip = async (reason: string, details: Record<string, string | null>) => {
      // Audited once per invoice and reason (the reconciliation looks again every day).
      if (await tx.auditLog.findFirst({ where: { action: 'sales.commission.skipped', targetId: deal.number, reason }, select: { id: true } })) return false;
      await this.audit.record({ actorId: null, action: 'sales.commission.skipped', targetType: 'sales_deal', targetId: deal.number, reason, details: { invoice: inv.number, source: from.source, ...details } }, tx);
      return false;
    };

    const baseline = await commissionBaseline(tx);
    if (!baseline) return false; // before the baseline nothing can qualify (it is later than any payment posted now)
    if (deal.wonStatus !== 'confirmed') return skip('deal_not_won', { wonStatus: deal.wonStatus });
    const { collected, pkr, fullyPaidAt } = await collectedValue(tx, inv.id, dec(inv.total));
    if (!fullyPaidAt) return false; // not fully paid by posted payments (yet): partial payments make nothing
    if (fullyPaidAt < baseline.baselineAt) return skip('paid_before_baseline', { fullyPaidAt: fullyPaidAt.toISOString(), baselineAt: baseline.baselineAt.toISOString() });
    const snap = await tx.salesCommissionEligibility.findUnique({ where: { dealId: deal.id } });
    if (!snap) return skip('no_eligibility_snapshot', {});
    if (!snap.eligible) return skip('earner_not_eligible_at_won', { basis: snap.basis, department: snap.departmentCode, role: snap.roleKey, status: snap.status });

    const paidOn = pkDate(fullyPaidAt);
    const line = await tx.salesCommissionLine.create({
      data: {
        dealId: deal.id,
        invoiceId: inv.id,
        paidEventId: from.eventId,
        source: from.source,
        eligibilityId: snap.id,
        earnerId: snap.earnerId,
        wonOwnerId: snap.earnerId,
        invoiceCurrency: inv.currency,
        collectedBase: collected,
        basePkr: pkr,
        fullyPaidAt,
        paidOn: dbDate(paidOn),
        status: 'waiting_rate',
      },
    });
    await this.audit.record({
      actorId: null,
      action: 'sales.commission.recorded',
      targetType: 'sales_commission_line',
      targetId: line.id,
      details: { deal: deal.number, invoice: inv.number, source: from.source, eligibility: snap.basis, currency: inv.currency, collected: collected.toFixed(2), basePkr: pkr.toFixed(2), fullyPaidAt: fullyPaidAt.toISOString() },
    }, tx);
    const rule = await this.ruleOn(tx, paidOn);
    if (!rule) {
      await tx.salesCommissionLineEvent.create({ data: { lineId: line.id, event: 'waiting_rate', fromStatus: null, toStatus: 'waiting_rate', reason: `No commission rule in force on ${paidOn}` } });
      return true;
    }
    await this.calculate(tx, line, rule);
    return true;
  }

  /** The rule in force on a day: the latest version of the latest effective day on or before it. */
  private ruleOn(db: Db, day: string) {
    return db.salesCommissionRule.findFirst({ where: { effectiveFrom: { lte: dbDate(day) } }, orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }] });
  }

  /** waiting_rate -> calculated, or held when the earner has LEFT (on notice is still employed): the rate and amount, once. */
  private async calculate(tx: Tx, line: Plain, rule: { id: string; version: number; ratePercent: Prisma.Decimal }): Promise<void> {
    const earner = await tx.employee.findUniqueOrThrow({ where: { id: line.earnerId }, select: { id: true, empId: true, fullName: true, status: true } });
    const leaver = earner.status === 'left';
    const amount = commissionAmount(line.basePkr, rule.ratePercent);
    const now = this.clock.now();
    const to: SalesCommissionStatus = leaver ? 'held' : 'calculated';
    const done = await tx.salesCommissionLine.updateMany({
      where: { id: line.id, version: line.version, status: 'waiting_rate' },
      data: {
        status: to,
        ruleId: rule.id,
        ruleVersion: rule.version,
        ratePercent: rule.ratePercent,
        amount,
        calculatedAt: now,
        version: { increment: 1 },
        ...(leaver ? { holdReason: 'earner_left' as const, heldAt: now, holdNote: `The earner (${earner.empId}) has left` } : {}),
      },
    });
    if (!done.count) return;
    const ruleText = `Rule version ${rule.version}: ${rule.ratePercent.toFixed(2)}%`;
    await tx.salesCommissionLineEvent.create({
      data: leaver
        ? { lineId: line.id, event: 'held', fromStatus: 'waiting_rate', toStatus: 'held', reason: `${ruleText}; held because the earner (${earner.empId}) has left` }
        : { lineId: line.id, event: 'calculated', fromStatus: 'waiting_rate', toStatus: 'calculated', reason: ruleText },
    });
    await this.audit.record({
      actorId: null,
      action: 'sales.commission.calculated',
      targetType: 'sales_commission_line',
      targetId: line.id,
      details: { earner: earner.empId, ruleVersion: rule.version, ratePercent: rule.ratePercent.toFixed(2), basePkr: dec(line.basePkr).toFixed(2), amount: amount.toFixed(2), status: to },
    }, tx);
    const deal = await tx.salesDeal.findUniqueOrThrow({ where: { id: line.dealId }, select: { number: true } });
    if (leaver) {
      for (const owner of await this.holders(tx, COMMISSION_APPROVE_DIRECTOR, earner.id)) {
        await this.notifications.create(tx, {
          recipientId: owner.id,
          type: 'approval_waiting',
          title: `Commission on ${deal.number} needs your final-settlement decision`,
          body: `${earner.fullName} (${earner.empId}) has left. PKR ${amount.toFixed(2)} is on hold until you decide.`,
          link: COMMISSION_LINK,
          dedupeKey: `sales_commission_leaver:${line.id}`,
        });
      }
      return;
    }
    await this.notifyApprovers(tx, line.id, earner, deal.number, amount);
  }

  /** The Director for a normal line; the Owner for the Director's own line (nobody approves their own commission). */
  private async notifyApprovers(tx: Tx, lineId: string, earner: { id: string; empId: string; fullName: string }, dealNumber: string, amount: Prisma.Decimal): Promise<void> {
    const directorsOwn = await this.permissions.can(earner.id, COMMISSION_APPROVE);
    const who = await this.holders(tx, directorsOwn ? COMMISSION_APPROVE_DIRECTOR : COMMISSION_APPROVE, earner.id);
    for (const r of who) {
      await this.notifications.create(tx, {
        recipientId: r.id,
        type: 'approval_waiting',
        title: `Commission on ${dealNumber} waits for your approval`,
        body: `${earner.fullName} (${earner.empId}): PKR ${amount.toFixed(2)}.`,
        link: COMMISSION_LINK,
        dedupeKey: `sales_commission_approval:${lineId}`,
      });
    }
  }

  /** Active holders of a permission through their role or an active duty, never the earner. */
  private async holders(db: Db, key: string, exceptId: string): Promise<Array<{ id: string }>> {
    return db.$queryRaw<Array<{ id: string }>>`
      SELECT e.id FROM employees e
      WHERE e.status = 'active' AND e.id <> ${exceptId}::uuid AND (
        EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = e.role_id AND p.key = ${key})
        OR EXISTS (SELECT 1 FROM employee_duties ed JOIN duty_permissions dp ON dp.duty_id = ed.duty_id JOIN permissions p ON p.id = dp.permission_id
                   WHERE ed.employee_id = e.id AND ed.ended_at IS NULL AND p.key = ${key}))
      ORDER BY e.emp_id`;
  }

  // ============================================================================================================== rules

  private async canSeeRules(actor: Actor): Promise<boolean> {
    return (await this.permissions.can(actor.id, COMMISSION_APPROVE)) || (await this.permissions.can(actor.id, COMMISSION_APPROVE_DIRECTOR));
  }

  /** GET /sales/commission/rules: the Director and the Owner only (404 for everyone else). */
  async rules(actor: Actor): Promise<SalesCommissionRulesView> {
    if (!(await this.canSeeRules(actor))) notFound();
    const rows = await this.prisma.salesCommissionRule.findMany({ include: { setBy: { select: { empId: true, fullName: true } } }, orderBy: { version: 'desc' } });
    const today = pkDate(this.clock.now());
    const inForce = rows.filter((r) => dayOf(r.effectiveFrom) <= today).sort((a, b) => dayOf(b.effectiveFrom).localeCompare(dayOf(a.effectiveFrom)) || b.version - a.version)[0];
    const b = await commissionBaseline(this.prisma);
    return { current: inForce ? ruleView(inForce) : null, versions: rows.map(ruleView), baselineAt: b?.baselineAt.toISOString() ?? null, baselineDay: b ? dayOf(b.businessDay) : null };
  }

  /**
   * PUT /sales/commission/rules: a new version of the company rule (the Director, with step-up and a reason). The FIRST rule
   * starts exactly on the baseline's business day (also a database trigger); later ones today or later. Lines waiting for a
   * rate are calculated with the rule now in force on their paid day; calculated lines never change.
   */
  async setRule(actor: Actor, sessionId: string | null, dto: SetSalesCommissionRuleRequest, client: RequestInfo): Promise<SalesCommissionRulesView> {
    if (!(await this.permissions.can(actor.id, COMMISSION_APPROVE))) notFound();
    await this.stepUp.require(actor, sessionId, 'sales_commission_rule', { type: 'sales_commission_rule' }, client);
    const today = pkDate(this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('sales_commission_rules', 0))`;
      const baseline = await commissionBaseline(tx);
      if (!baseline) conflict('baseline_missing', 'The M15.7 baseline is not recorded yet, so no commission rule can be set');
      const baselineDay = dayOf(baseline.businessDay);
      const last = await tx.salesCommissionRule.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
      if (!last && dto.effectiveFrom !== baselineDay) badRequest('first_rule_baseline_day', `The first rule starts on the baseline day (${baselineDay})`);
      if (last && dto.effectiveFrom < today) badRequest('rule_in_past', 'A new rule starts today or later');
      const rule = await tx.salesCommissionRule.create({
        data: { version: (last?.version ?? 0) + 1, ratePercent: dec(dto.ratePercent), effectiveFrom: dbDate(dto.effectiveFrom), reason: dto.reason.trim(), setById: actor.id },
      });
      await this.audit.record({
        actorId: actor.id,
        action: 'sales.commission.rule_set',
        targetType: 'sales_commission_rule',
        targetId: String(rule.version),
        reason: dto.reason.trim(),
        details: { version: rule.version, ratePercent: rule.ratePercent.toFixed(2), effectiveFrom: dto.effectiveFrom, previousVersion: last?.version ?? null },
        ...client,
      }, tx);
      const waiting = await tx.salesCommissionLine.findMany({ where: { status: 'waiting_rate' }, orderBy: { createdAt: 'asc' } });
      for (const line of waiting) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sales_commission:${line.dealId}`}, 0))`;
        const r = await this.ruleOn(tx, dayOf(line.paidOn));
        if (r) await this.calculate(tx, line, r);
      }
    });
    noteActivity({ target: 'sales commission rule', description: `Set the commission rule to ${dto.ratePercent}% from ${dto.effectiveFrom}` });
    return this.rules(actor);
  }

  // ========================================================================================================= decisions

  private async powers(actor: Actor): Promise<Powers> {
    const access = await this.permissions.getEffectiveAccess(actor.id);
    return {
      actor,
      approve: access.permissions.has(COMMISSION_APPROVE),
      approveDirector: access.permissions.has(COMMISSION_APPROVE_DIRECTOR),
      hold: access.permissions.has(COMMISSION_HOLD),
    };
  }

  /** The earners who hold the approve permission themselves (the Director): only the Owner decides their lines. */
  private async directorEarners(ids: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const id of new Set(ids)) if (await this.permissions.can(id, COMMISSION_APPROVE)) out.add(id);
    return out;
  }

  /** True when the earner holds the approve permission themselves (the Director): the Owner decides their lines. */
  async isDirectorsOwn(earnerEmpId: string): Promise<boolean> {
    const e = await this.prisma.employee.findUnique({ where: { empId: earnerEmpId }, select: { id: true } });
    return !!e && (await this.permissions.can(e.id, COMMISSION_APPROVE));
  }

  /**
   * What `p` may do on a line now (approved and corrected scope):
   *  - nobody decides their own line;
   *  - a line held because the earner left: only the Owner, through the final-settlement decision;
   *  - the Director's own line: only the Owner approves or rejects it (step-up, reason); nobody holds it;
   *  - a normal line: the Director approves; the Director or the Finance duty holds or rejects.
   */
  private can(p: Powers, l: Pick<Plain, 'earnerId' | 'status' | 'holdReason'>, directorsOwn: boolean): SalesCommissionLineView['can'] {
    const none = { approve: false, reject: false, hold: false, decideLeaver: false };
    if (l.earnerId === p.actor.id) return none;
    if (l.status === 'held' && l.holdReason === 'earner_left') return { ...none, decideLeaver: p.approveDirector };
    const open = l.status === 'calculated' || l.status === 'held';
    if (directorsOwn) return { ...none, approve: p.approveDirector && open, reject: p.approveDirector && (open || l.status === 'approved') };
    return {
      ...none,
      approve: p.approve && open,
      reject: (p.approve || p.hold) && (open || l.status === 'approved'),
      hold: p.hold && (l.status === 'calculated' || l.status === 'approved'),
    };
  }

  /** Loads a line for a decision under the deal's lock, with the version read, and what the actor may do on it. */
  private async forDecision(tx: Tx, actor: Actor, id: string, version: number) {
    const found = await tx.salesCommissionLine.findUnique({ where: { id }, select: { dealId: true } });
    if (!found) notFound('Commission line not found');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sales_commission:${found.dealId}`}, 0))`;
    const line = await tx.salesCommissionLine.findUniqueOrThrow({ where: { id }, include: lineInclude });
    const p = await this.powers(actor);
    if (!(await this.visible(actor, line))) notFound('Commission line not found');
    if (line.earnerId === actor.id) forbidden('self_approval', 'Nobody decides their own commission');
    if (line.version !== version) conflict('stale_version', 'This commission line was changed by someone else. Reload it');
    const directorsOwn = (await this.directorEarners([line.earnerId])).has(line.earnerId);
    return { line, p, directorsOwn, can: this.can(p, line, directorsOwn) };
  }

  private async afterDecision(tx: Tx, line: LineRow, kind: 'approved' | 'rejected' | 'held', reason: string | null): Promise<void> {
    if (line.earner.status === 'left') return; // leavers are not notified (they have no access any more)
    const amount = line.amount ? `PKR ${line.amount.toFixed(2)}` : 'Your commission';
    const text = { approved: 'was approved', rejected: 'was rejected', held: 'is on hold' }[kind];
    await this.notifications.create(tx, {
      recipientId: line.earnerId,
      type: 'sales_commission_decided',
      title: `Commission on ${line.deal.number} ${text}`,
      body: reason ? `${amount}. ${reason}` : `${amount}.`,
      link: COMMISSION_LINK,
      dedupeKey: `sales_commission_decided:${line.id}:${kind}:${line.version + 1}`,
    });
  }

  private async moved(tx: Tx, line: LineRow, data: Prisma.SalesCommissionLineUncheckedUpdateManyInput): Promise<void> {
    const done = await tx.salesCommissionLine.updateMany({ where: { id: line.id, version: line.version }, data: { ...data, version: { increment: 1 } } });
    if (!done.count) conflict('stale_version', 'This commission line was changed by someone else. Reload it');
  }

  /**
   * POST /sales/commission/:id/approve: the Director (normal lines); the Director's own line: the Owner only, with a fresh
   * step-up and a reason.
   */
  async approve(actor: Actor, sessionId: string | null, id: string, dto: { version: number; reason?: string }, client: RequestInfo): Promise<SalesCommissionLineView> {
    const reason = dto.reason?.trim() || null;
    await this.prisma.$transaction(async (tx) => {
      const { line, can, directorsOwn } = await this.forDecision(tx, actor, id, dto.version);
      if (line.status === 'held' && line.holdReason === 'earner_left') conflict('leaver_decision', 'The earner has left: the Owner makes the final-settlement decision');
      if (!can.approve) {
        if (line.status !== 'calculated' && line.status !== 'held') conflict('invalid_transition', `A line that is ${line.status} cannot be approved`);
        forbidden('not_allowed', directorsOwn ? "Only the Owner approves the Director's own commission" : 'Only the Director approves commission');
      }
      if (directorsOwn) {
        if (!reason || reason.length < 5) badRequest('reason_required', 'Please give a reason (at least 5 characters)');
        await this.stepUp.require(actor, sessionId, 'sales_commission_approve', { type: 'sales_commission_line', id }, client);
      }
      const now = this.clock.now();
      const payrollMonth = monthOf(pkDate(now));
      await this.moved(tx, line, { status: 'approved', approvedById: actor.id, approvedAt: now, payrollMonth });
      await tx.salesCommissionLineEvent.create({ data: { lineId: id, event: 'approved', fromStatus: line.status, toStatus: 'approved', actorId: actor.id, reason: reason ? `Payroll month ${payrollMonth}: ${reason}` : `Payroll month ${payrollMonth}` } });
      await this.audit.record({ actorId: actor.id, action: 'sales.commission.approved', targetType: 'sales_commission_line', targetId: id, reason, details: { deal: line.deal.number, earner: line.earner.empId, amount: line.amount?.toFixed(2) ?? null, payrollMonth, from: line.status, ownerDecision: directorsOwn }, ...client }, tx);
      await this.outbox.emit({ type: 'sales.commission.approved', actor: actor.empId, payload: { dealNumber: line.deal.number, empId: line.earner.empId, approvedByEmpId: actor.empId, payrollMonth } }, tx);
      await this.afterDecision(tx, line, 'approved', null);
    });
    noteActivity({ target: id, description: 'Approved a commission line' });
    return this.one(actor, id);
  }

  /**
   * POST /sales/commission/:id/reject: a normal line: the Director, or the Director / Finance duty by hand (for example after
   * a refund); the Director's own line: the Owner only, with a fresh step-up.
   */
  async reject(actor: Actor, sessionId: string | null, id: string, dto: { reason: string; version: number }, client: RequestInfo): Promise<SalesCommissionLineView> {
    const reason = dto.reason.trim();
    await this.prisma.$transaction(async (tx) => {
      const { line, can, directorsOwn } = await this.forDecision(tx, actor, id, dto.version);
      if (line.status === 'held' && line.holdReason === 'earner_left') conflict('leaver_decision', 'The earner has left: the Owner makes the final-settlement decision');
      if (!can.reject) {
        if (!['calculated', 'held', 'approved'].includes(line.status)) conflict('invalid_transition', `A line that is ${line.status} cannot be rejected`);
        forbidden('not_allowed', directorsOwn ? "Only the Owner decides the Director's own commission" : 'You may not reject this commission line');
      }
      if (directorsOwn) await this.stepUp.require(actor, sessionId, 'sales_commission_reject', { type: 'sales_commission_line', id }, client);
      await this.moved(tx, line, { status: 'rejected', rejectedById: actor.id, rejectedAt: this.clock.now(), rejectReason: reason });
      await tx.salesCommissionLineEvent.create({ data: { lineId: id, event: 'rejected', fromStatus: line.status, toStatus: 'rejected', actorId: actor.id, reason } });
      await this.audit.record({ actorId: actor.id, action: 'sales.commission.rejected', targetType: 'sales_commission_line', targetId: id, reason, details: { deal: line.deal.number, earner: line.earner.empId, amount: line.amount?.toFixed(2) ?? null, from: line.status, ownerDecision: directorsOwn }, ...client }, tx);
      await this.afterDecision(tx, line, 'rejected', reason);
    });
    noteActivity({ target: id, description: 'Rejected a commission line' });
    return this.one(actor, id);
  }

  /** POST /sales/commission/:id/hold: the Director or the Finance duty, with a reason, on a normal line (calculated or approved). */
  async hold(actor: Actor, id: string, dto: { reason: string; version: number }, client: RequestInfo): Promise<SalesCommissionLineView> {
    const reason = dto.reason.trim();
    await this.prisma.$transaction(async (tx) => {
      const { line, can, p, directorsOwn } = await this.forDecision(tx, actor, id, dto.version);
      if (!can.hold) {
        if (directorsOwn) forbidden('not_allowed', "Only the Owner decides the Director's own commission");
        if (p.hold) conflict('invalid_transition', `A line that is ${line.status} cannot be put on hold`);
        forbidden('not_allowed', 'Only the Director or the Finance duty puts commission on hold');
      }
      await this.moved(tx, line, { status: 'held', holdReason: 'manual', holdNote: reason, heldById: actor.id, heldAt: this.clock.now() });
      await tx.salesCommissionLineEvent.create({ data: { lineId: id, event: 'held', fromStatus: line.status, toStatus: 'held', actorId: actor.id, reason } });
      await this.audit.record({ actorId: actor.id, action: 'sales.commission.held', targetType: 'sales_commission_line', targetId: id, reason, details: { deal: line.deal.number, earner: line.earner.empId, from: line.status }, ...client }, tx);
      await this.afterDecision(tx, line, 'held', reason);
    });
    noteActivity({ target: id, description: 'Put a commission line on hold' });
    return this.one(actor, id);
  }

  /** POST /sales/commission/:id/leaver-decision: the Owner alone, with step-up and a reason; recorded once, for ever. */
  async leaverDecision(actor: Actor, sessionId: string | null, id: string, dto: { decision: 'pay' | 'forfeit'; reason: string; version: number }, client: RequestInfo): Promise<SalesCommissionLineView> {
    const reason = dto.reason.trim();
    await this.prisma.$transaction(async (tx) => {
      const { line, can, p } = await this.forDecision(tx, actor, id, dto.version);
      if (!p.approveDirector) forbidden('not_allowed', 'Only the Owner makes the final-settlement decision');
      if (!can.decideLeaver) conflict('invalid_transition', 'Only a line held because the earner left takes this decision');
      await this.stepUp.require(actor, sessionId, 'sales_commission_leaver', { type: 'sales_commission_line', id }, client);
      const now = this.clock.now();
      const decided = { leaverDecision: dto.decision, leaverDecidedById: actor.id, leaverDecidedAt: now, leaverReason: reason };
      const payrollMonth = monthOf(pkDate(now));
      if (dto.decision === 'pay') await this.moved(tx, line, { ...decided, status: 'approved', approvedById: actor.id, approvedAt: now, payrollMonth });
      else await this.moved(tx, line, { ...decided, status: 'rejected', rejectedById: actor.id, rejectedAt: now, rejectReason: reason });
      const to = dto.decision === 'pay' ? 'approved' : 'rejected';
      await tx.salesCommissionLineEvent.create({ data: { lineId: id, event: 'leaver_decided', fromStatus: 'held', toStatus: to, actorId: actor.id, reason: `${dto.decision}: ${reason}` } });
      await this.audit.record({ actorId: actor.id, action: 'sales.commission.leaver_decided', targetType: 'sales_commission_line', targetId: id, reason, details: { deal: line.deal.number, earner: line.earner.empId, decision: dto.decision, amount: line.amount?.toFixed(2) ?? null, payrollMonth: dto.decision === 'pay' ? payrollMonth : null }, ...client }, tx);
      if (dto.decision === 'pay') {
        await this.outbox.emit({ type: 'sales.commission.approved', actor: actor.empId, payload: { dealNumber: line.deal.number, empId: line.earner.empId, approvedByEmpId: actor.empId, payrollMonth } }, tx);
      }
    });
    noteActivity({ target: id, description: `Final-settlement decision on a commission line: ${dto.decision}` });
    return this.one(actor, id);
  }

  // ============================================================================================================= views

  /** own: the viewer's lines; team: their reporting line (sales managers); all: commission_view (Director, Owner, Finance). */
  private async scopeOf(actor: Actor): Promise<{ scope: 'own' | 'team' | 'all'; where: Prisma.SalesCommissionLineWhereInput } | null> {
    if (await this.permissions.can(actor.id, COMMISSION_VIEW)) return { scope: 'all', where: {} };
    const a = await this.access.of(actor);
    if (a.manage) return { scope: 'team', where: { earner: this.scope.employeeWhere(actor.id) } };
    if (a.own) return { scope: 'own', where: { earnerId: actor.id } };
    return null;
  }

  private async visible(actor: Actor, line: Pick<Plain, 'id'>): Promise<boolean> {
    const s = await this.scopeOf(actor);
    if (!s) return false;
    return (await this.prisma.salesCommissionLine.count({ where: { AND: [{ id: line.id }, s.where] } })) > 0;
  }

  /** GET /sales/commission (404 for anyone without any commission view). */
  async list(actor: Actor, q: SalesCommissionListQuery): Promise<SalesCommissionListView> {
    const s = await this.scopeOf(actor);
    if (!s) notFound();
    const where: Prisma.SalesCommissionLineWhereInput[] = [s.where];
    if (q.status) where.push({ status: q.status });
    if (q.empId) where.push({ earner: { empId: q.empId } });
    const rows = await this.prisma.salesCommissionLine.findMany({ where: { AND: where }, include: lineInclude, orderBy: [{ createdAt: 'desc' }], take: 500 });
    const p = await this.powers(actor);
    const directors = await this.directorEarners(rows.map((r) => r.earnerId));
    return { scope: s.scope, lines: rows.map((r) => this.view(r, this.can(p, r, directors.has(r.earnerId)))), totals: totalsOf(rows) };
  }

  /** GET /sales/commission/:id. */
  async one(actor: Actor, id: string): Promise<SalesCommissionLineView> {
    const s = await this.scopeOf(actor);
    if (!s) notFound();
    const row = await this.prisma.salesCommissionLine.findFirst({ where: { AND: [{ id }, s.where] }, include: lineInclude });
    if (!row) notFound('Commission line not found');
    const p = await this.powers(actor);
    const directors = await this.directorEarners([row.earnerId]);
    return this.view(row, this.can(p, row, directors.has(row.earnerId)));
  }

  /** The approvals inbox: lines waiting for THIS person's decision. */
  async waitingFor(actor: Actor): Promise<SalesCommissionLineView[]> {
    const p = await this.powers(actor);
    if (!p.approve && !p.approveDirector) return [];
    const rows = await this.prisma.salesCommissionLine.findMany({ where: { status: { in: ['calculated', 'held'] }, earnerId: { not: actor.id } }, include: lineInclude, orderBy: { createdAt: 'asc' } });
    const directors = await this.directorEarners(rows.map((r) => r.earnerId));
    return rows
      .map((r) => this.view(r, this.can(p, r, directors.has(r.earnerId))))
      .filter((v) => v.can.decideLeaver || (v.can.approve && (v.status === 'calculated' || v.hold?.reason === 'manual')));
  }

  private view(r: LineRow, can: SalesCommissionLineView['can']): SalesCommissionLineView {
    return {
      id: r.id,
      version: r.version,
      dealId: r.deal.id,
      dealNumber: r.deal.number,
      invoiceNumber: r.invoice.number,
      companyName: r.deal.company.name,
      earner: person(r.earner),
      wonOwner: person(r.wonOwner),
      eligibility: { basis: r.eligibility.basis, at: r.eligibility.evaluatedAt.toISOString() },
      source: r.source,
      invoiceCurrency: r.invoiceCurrency,
      collectedBase: r.collectedBase.toFixed(2),
      basePkr: r.basePkr.toFixed(2),
      fullyPaidAt: r.fullyPaidAt.toISOString(),
      paidOn: dayOf(r.paidOn),
      ruleVersion: r.ruleVersion,
      ratePercent: r.ratePercent?.toFixed(2) ?? null,
      amount: r.amount?.toFixed(2) ?? null,
      currency: 'PKR',
      status: r.status,
      calculatedAt: r.calculatedAt?.toISOString() ?? null,
      hold: r.status === 'held' && r.holdReason && r.heldAt ? { reason: r.holdReason, note: r.holdNote, by: r.heldBy ? person(r.heldBy) : null, at: r.heldAt.toISOString() } : null,
      approval: r.approvedBy && r.approvedAt && r.payrollMonth && (r.status === 'approved' || r.status === 'included') ? { by: person(r.approvedBy), at: r.approvedAt.toISOString(), payrollMonth: r.payrollMonth } : null,
      rejection: r.status === 'rejected' && r.rejectedAt && r.rejectReason ? { by: r.rejectedBy ? person(r.rejectedBy) : null, at: r.rejectedAt.toISOString(), reason: r.rejectReason } : null,
      leaverDecision: r.leaverDecision && r.leaverDecidedBy && r.leaverDecidedAt && r.leaverReason ? { decision: r.leaverDecision, by: person(r.leaverDecidedBy), at: r.leaverDecidedAt.toISOString(), reason: r.leaverReason } : null,
      includedAt: r.includedAt?.toISOString() ?? null,
      can,
      history: r.events.map((e) => ({ event: e.event, fromStatus: e.fromStatus, toStatus: e.toStatus, by: e.actor ? person(e.actor) : null, reason: e.reason, at: e.at.toISOString() })),
    };
  }
}

function ruleView(r: RuleRow): SalesCommissionRuleView {
  return { version: r.version, ratePercent: r.ratePercent.toFixed(2), effectiveFrom: dayOf(r.effectiveFrom), reason: r.reason, setBy: person(r.setBy), setAt: r.createdAt.toISOString() };
}

/** Per status: how many lines, the PKR commission, and what was collected per invoice currency (never converted). */
export function totalsOf(rows: Array<Pick<Plain, 'status' | 'amount' | 'invoiceCurrency' | 'collectedBase'>>): SalesCommissionTotals[] {
  const out: SalesCommissionTotals[] = [];
  for (const status of SALES_COMMISSION_STATUSES) {
    const mine = rows.filter((r) => r.status === status);
    if (!mine.length) continue;
    const byCurrency = new Map<Currency, Prisma.Decimal>();
    let amount = ZERO;
    for (const r of mine) {
      if (r.amount) amount = amount.plus(r.amount);
      byCurrency.set(r.invoiceCurrency, (byCurrency.get(r.invoiceCurrency) ?? ZERO).plus(r.collectedBase));
    }
    out.push({
      status,
      count: mine.length,
      amount: amount.toFixed(2),
      collected: [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => ({ currency, total: total.toFixed(2) })),
    });
  }
  return out;
}
