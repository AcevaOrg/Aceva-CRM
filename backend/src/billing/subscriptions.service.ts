import { Injectable } from '@nestjs/common';
import type { RenewalEventView, SubscriptionCostView, SubscriptionInput, SubscriptionView, UsageReadingView } from '@aceva/contracts';
import { z } from 'zod';
import type { renewalDecisionSchema, subscriptionCostSchema, updateSubscriptionSchema, usageReadingSchema } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { dec, money } from '../common/money';
import { addDays, dayOf, dbDate, pkDate } from '../common/pakistan-time';
import { OutboxService } from '../events/outbox.service';
import { badRequest, conflict, notFound } from '../finance/finance-errors';
import type { Prisma } from '../generated/prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { nextPeriodStart } from './billing-dates';

type Tx = Prisma.TransactionClient;
type RenewalDecision = z.infer<typeof renewalDecisionSchema>;
type UsageReading = z.infer<typeof usageReadingSchema>;
type CostInput = z.infer<typeof subscriptionCostSchema>;
type SubscriptionUpdate = z.infer<typeof updateSubscriptionSchema>;

const include = {
  owner: { select: { empId: true } },
  usage: { orderBy: [{ readingDate: 'desc' }, { createdAt: 'desc' }], take: 7 },
  costs: { orderBy: { month: 'desc' }, take: 12 },
  renewalEvents: { where: { kind: { not: 'alert' } }, orderBy: { createdAt: 'desc' }, take: 1 },
} as const satisfies Prisma.SubscriptionInclude;
type Row = Prisma.SubscriptionGetPayload<{ include: typeof include }>;

/** Near the limit at 80 % or more. */
const NEAR_LIMIT = 0.8;

/**
 * Module 13: Aceva's own subscriptions and services (plan section 18): the register, renewal alerts and decisions, usage
 * readings and cost records. No provider is connected yet, so usage and costs are typed in; a cost is "Estimated" unless
 * it is backed by a Module 9 bill or the provider's invoice reference (also a database rule), and a cost on a usage
 * reading is always an estimate. Nothing here posts money: paying a provider is a Module 9 bill.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private today(): string {
    return pkDate(this.clock.now());
  }

  /** near_limit (80 % or more of the limit) or unusual (the latest rise is more than 1.5 times the earlier average rise). */
  static usageFlag(readingsOldestFirst: Array<{ used: number; limit: number | null }>): 'near_limit' | 'unusual' | null {
    const last = readingsOldestFirst[readingsOldestFirst.length - 1];
    if (!last) return null;
    if (last.limit && last.used / last.limit >= NEAR_LIMIT) return 'near_limit';
    const t = readingsOldestFirst.map((r) => r.used);
    if (t.length >= 3) {
      const prev = t.slice(0, -1);
      const avg = prev.slice(1).reduce((s, v, i) => s + (v - prev[i]), 0) / Math.max(1, prev.length - 1);
      const lastRise = t[t.length - 1] - t[t.length - 2];
      if (avg > 0 && lastRise > avg * 1.5) return 'unusual';
    }
    return null;
  }

  private async people(rows: Row[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.flatMap((r) => [...r.usage.map((u) => u.enteredBy), ...r.costs.map((c) => c.updatedBy ?? c.enteredBy)]).filter((x): x is string => !!x))];
    const found = ids.length ? await this.prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, empId: true } }) : [];
    return new Map(found.map((e) => [e.id, e.empId]));
  }

  private view(r: Row, emp: Map<string, string>): SubscriptionView {
    const today = this.today();
    const usage = [...r.usage].reverse();
    const status: SubscriptionView['status'] =
      r.status === 'cancelled'
        ? 'cancelled'
        : addDays(dayOf(r.renewalDate), -r.alertDaysBefore) <= today
          ? 'renewing_soon'
          : r.renewalEvents[0]?.kind === 'changed'
            ? 'changed'
            : 'active';
    const limitOf = (u: Row['usage'][number]) => (u.limit ? Number(u.limit) : r.usageLimit ? Number(r.usageLimit) : null);
    return {
      id: r.id,
      number: r.number,
      vendor: r.vendor,
      product: r.product,
      category: r.category as SubscriptionView['category'],
      ownerEmpId: r.owner.empId,
      plan: r.plan,
      cost: money(r.cost),
      currency: r.currency,
      period: r.period,
      renewalDate: dayOf(r.renewalDate),
      alertDaysBefore: r.alertDaysBefore,
      seats: r.seats,
      usageMetric: r.usageMetric,
      usageUnit: r.usageUnit,
      usageLimit: r.usageLimit ? dec(r.usageLimit).toString() : null,
      notes: r.notes,
      status,
      usage: usage.map(
        (u): UsageReadingView => ({
          id: u.id,
          readingDate: dayOf(u.readingDate),
          used: dec(u.used).toString(),
          limit: u.limit ? dec(u.limit).toString() : r.usageLimit ? dec(r.usageLimit).toString() : null,
          estimatedCost: u.estimatedCost ? money(u.estimatedCost) : null,
          source: u.source as 'manual' | 'api',
          note: u.note,
          enteredByEmpId: u.enteredBy ? (emp.get(u.enteredBy) ?? null) : null,
          createdAt: u.createdAt.toISOString(),
        }),
      ),
      usageFlag: SubscriptionsService.usageFlag(usage.map((u) => ({ used: Number(u.used), limit: limitOf(u) }))),
      costs: r.costs.map(
        (c): SubscriptionCostView => ({ id: c.id, month: c.month, amount: money(c.amount), currency: c.currency, estimated: c.estimated, billId: c.billId, reference: c.reference, note: c.note, enteredByEmpId: emp.get(c.updatedBy ?? c.enteredBy ?? '') ?? null, updatedAt: c.updatedAt.toISOString() }),
      ),
    };
  }

  async list(): Promise<SubscriptionView[]> {
    const rows = await this.prisma.subscription.findMany({ include, orderBy: [{ status: 'asc' }, { renewalDate: 'asc' }] });
    const emp = await this.people(rows);
    return rows.map((r) => this.view(r, emp));
  }

  async get(id: string): Promise<SubscriptionView> {
    const r = await this.prisma.subscription.findUnique({ where: { id }, include });
    if (!r) throw notFound('Subscription');
    return this.view(r, await this.people([r]));
  }

  async renewalEvents(subscriptionId?: string): Promise<RenewalEventView[]> {
    const rows = await this.prisma.subscriptionRenewalEvent.findMany({ where: subscriptionId ? { subscriptionId } : {}, orderBy: { createdAt: 'desc' }, take: 200 });
    const people = await this.prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))] } }, select: { id: true, empId: true } });
    const emp = new Map(people.map((p) => [p.id, p.empId]));
    return rows.map((r) => ({
      id: r.id,
      subscriptionId: r.subscriptionId,
      kind: r.kind,
      renewalDate: dayOf(r.renewalDate),
      newRenewalDate: r.newRenewalDate ? dayOf(r.newRenewalDate) : null,
      oldCost: r.oldCost ? money(r.oldCost) : null,
      newCost: r.newCost ? money(r.newCost) : null,
      oldPlan: r.oldPlan,
      newPlan: r.newPlan,
      note: r.note,
      byEmpId: r.actorId ? (emp.get(r.actorId) ?? null) : null,
      at: r.createdAt.toISOString(),
    }));
  }

  private async owner(db: Tx | PrismaService, empId: string): Promise<string> {
    const e = await db.employee.findUnique({ where: { empId }, select: { id: true, status: true } });
    if (!e || e.status === 'left') throw badRequest('unknown_employee', `Employee ${empId} does not exist or has left`);
    return e.id;
  }

  async create(actor: Actor, dto: SubscriptionInput, client: RequestInfo): Promise<SubscriptionView> {
    const id = await this.prisma.$transaction(async (tx) => {
      const row = await tx.subscription.create({
        data: {
          vendor: dto.vendor,
          product: dto.product,
          category: dto.category,
          ownerId: await this.owner(tx, dto.ownerEmpId),
          plan: dto.plan,
          cost: dec(dto.cost),
          currency: dto.currency,
          period: dto.period,
          renewalDate: dbDate(dto.renewalDate),
          alertDaysBefore: dto.alertDaysBefore,
          seats: dto.seats ?? null,
          usageMetric: dto.usageMetric || null,
          usageUnit: dto.usageUnit || null,
          usageLimit: dto.usageLimit ? dec(dto.usageLimit) : null,
          notes: dto.notes || null,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      await this.audit.record({ actorId: actor.id, action: 'billing.subscription.created', targetType: 'subscription', targetId: row.number, details: { vendor: row.vendor, product: row.product, cost: money(row.cost), currency: row.currency, period: row.period }, ...client }, tx);
      return row.id;
    });
    return this.get(id);
  }

  /** Details only (owner, alert days, seats, usage limit, notes...). Cost, plan, renewal date and cancelling are renewal decisions. */
  async update(actor: Actor, id: string, dto: SubscriptionUpdate, client: RequestInfo): Promise<SubscriptionView> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.subscription.findUnique({ where: { id } });
      if (!before) throw notFound('Subscription');
      if (before.status === 'cancelled') throw conflict('invalid_transition', 'A cancelled subscription cannot be changed');
      const { ownerEmpId, usageLimit, ...rest } = dto;
      await tx.subscription.update({
        where: { id },
        data: {
          ...rest,
          ...(ownerEmpId ? { ownerId: await this.owner(tx, ownerEmpId) } : {}),
          ...(usageLimit !== undefined ? { usageLimit: usageLimit ? dec(usageLimit) : null } : {}),
          updatedBy: actor.id,
        },
      });
      await this.audit.record({ actorId: actor.id, action: 'billing.subscription.updated', targetType: 'subscription', targetId: before.number, details: { fields: Object.keys(dto) }, ...client }, tx);
    });
    return this.get(id);
  }

  /** Renewed (the renewal date moves on), changed (plan, cost or period) or cancelled. Recorded in the insert-only history. */
  async decide(actor: Actor, id: string, dto: RenewalDecision, client: RequestInfo): Promise<SubscriptionView> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM subscriptions WHERE id = ${id}::uuid FOR UPDATE`;
      const s = await tx.subscription.findUnique({ where: { id } });
      if (!s) throw notFound('Subscription');
      if (s.status === 'cancelled') throw conflict('invalid_transition', 'This subscription is already cancelled');
      const renewal = dayOf(s.renewalDate);
      const period = dto.newPeriod ?? s.period;
      const nextDate = dto.decision === 'cancelled' ? null : (dto.nextRenewalDate ?? nextPeriodStart(renewal, period));
      if (nextDate && nextDate <= this.today() && dto.decision === 'renewed') throw badRequest('invalid_date', 'The next renewal date must be in the future');
      const newCost = dto.decision === 'changed' && dto.newCost ? dec(dto.newCost) : null;
      await tx.subscription.update({
        where: { id },
        data:
          dto.decision === 'cancelled'
            ? { status: 'cancelled', cancelledAt: this.clock.now(), updatedBy: actor.id }
            : { renewalDate: dbDate(nextDate!), ...(dto.decision === 'changed' ? { plan: dto.newPlan ?? s.plan, cost: newCost ?? s.cost, period } : {}), updatedBy: actor.id },
      });
      await tx.subscriptionRenewalEvent.create({
        data: {
          subscriptionId: id,
          kind: dto.decision,
          renewalDate: s.renewalDate,
          newRenewalDate: nextDate ? dbDate(nextDate) : null,
          oldCost: dto.decision === 'changed' ? s.cost : null,
          newCost,
          oldPlan: dto.decision === 'changed' ? s.plan : null,
          newPlan: dto.decision === 'changed' ? (dto.newPlan ?? null) : null,
          note: dto.note || null,
          actorId: actor.id,
          createdAt: this.clock.now(),
        },
      });
      await this.audit.record({ actorId: actor.id, action: `billing.subscription.${dto.decision}`, targetType: 'subscription', targetId: s.number, reason: dto.note ?? null, details: { renewalDate: renewal, next: nextDate, newCost: newCost ? money(newCost) : null }, ...client }, tx);
    });
    return this.get(id);
  }

  /** A usage reading typed in by hand. Near the limit or unusual: the responsible person is told (once per reading). */
  async addUsage(actor: Actor, id: string, dto: UsageReading, client: RequestInfo): Promise<SubscriptionView> {
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.subscription.findUnique({ where: { id }, include: { usage: { orderBy: [{ readingDate: 'desc' }, { createdAt: 'desc' }], take: 6 } } });
      if (!s) throw notFound('Subscription');
      if (s.status === 'cancelled') throw conflict('invalid_transition', 'A cancelled subscription takes no readings');
      if (dto.readingDate > this.today()) throw badRequest('invalid_date', 'A reading cannot be in the future');
      const reading = await tx.usageSnapshot.create({
        data: {
          subscriptionId: id,
          readingDate: dbDate(dto.readingDate),
          used: dec(dto.used),
          limit: dto.limit ? dec(dto.limit) : s.usageLimit,
          estimatedCost: dto.estimatedCost ? dec(dto.estimatedCost) : null,
          source: 'manual',
          note: dto.note || null,
          enteredBy: actor.id,
          createdAt: this.clock.now(),
        },
      });
      await this.audit.record({ actorId: actor.id, action: 'billing.subscription.usage_recorded', targetType: 'subscription', targetId: s.number, details: { readingDate: dto.readingDate, used: dto.used, estimatedCost: dto.estimatedCost ?? null }, ...client }, tx);
      const readings = [...s.usage].reverse().map((u) => ({ used: Number(u.used), limit: u.limit ? Number(u.limit) : null }));
      readings.push({ used: Number(reading.used), limit: reading.limit ? Number(reading.limit) : null });
      const flag = SubscriptionsService.usageFlag(readings);
      if (flag) {
        const limit = reading.limit ? ` of ${dec(reading.limit).toString()}` : '';
        await this.notifications.create(tx, {
          recipientId: s.ownerId,
          type: 'usage_alert',
          title: flag === 'near_limit' ? `${s.vendor} ${s.product} is near its limit` : `${s.vendor} ${s.product} usage rose unusually`,
          body: `Reading on ${dto.readingDate}: ${dto.used}${limit}${s.usageUnit ? ` ${s.usageUnit}` : ''} (entered by hand).`,
          link: '/billing/subscriptions',
          dedupeKey: `usage:${reading.id}`,
        });
      }
    });
    return this.get(id);
  }

  /** The cost of one month (one record per month; changing it is logged with the old and new amount). */
  async setCost(actor: Actor, id: string, month: string, dto: CostInput, client: RequestInfo): Promise<SubscriptionView> {
    await this.prisma.$transaction(async (tx) => {
      const s = await tx.subscription.findUnique({ where: { id }, select: { number: true } });
      if (!s) throw notFound('Subscription');
      if (dto.billId) {
        const bill = await tx.bill.findUnique({ where: { id: dto.billId }, select: { id: true } });
        if (!bill) throw badRequest('unknown_bill', 'The bill does not exist');
      }
      const before = await tx.subscriptionCost.findUnique({ where: { subscriptionId_month: { subscriptionId: id, month } } });
      const data = { amount: dec(dto.amount), currency: dto.currency, estimated: dto.estimated, billId: dto.billId ?? null, reference: dto.reference || null, note: dto.note || null, updatedBy: actor.id };
      await tx.subscriptionCost.upsert({ where: { subscriptionId_month: { subscriptionId: id, month } }, create: { subscriptionId: id, month, ...data, enteredBy: actor.id }, update: data });
      await this.audit.record(
        { actorId: actor.id, action: 'billing.subscription.cost_recorded', targetType: 'subscription', targetId: s.number, details: { month, old: before ? `${before.currency} ${money(before.amount)}${before.estimated ? ' (estimated)' : ''}` : null, new: `${dto.currency} ${dto.amount}${dto.estimated ? ' (estimated)' : ''}` }, ...client },
        tx,
      );
    });
    return this.get(id);
  }

  /**
   * Daily job: a subscription whose renewal is inside its alert window gets one alert (unique per subscription and renewal
   * date, a database rule), its responsible person is told, and the renewal_due event is written.
   */
  async runRenewalAlerts(day: string): Promise<number> {
    const subs = await this.prisma.subscription.findMany({ where: { status: 'active' }, include: { owner: { select: { empId: true } } } });
    let count = 0;
    for (const s of subs) {
      const renewal = dayOf(s.renewalDate);
      if (addDays(renewal, -s.alertDaysBefore) > day) continue;
      const done = await this.prisma.$transaction(async (tx) => {
        const now = this.clock.now();
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO subscription_renewal_events (subscription_id, kind, renewal_date, created_at)
          VALUES (${s.id}::uuid, 'alert', ${renewal}::date, ${now})
          ON CONFLICT (subscription_id, renewal_date) WHERE kind = 'alert' DO NOTHING
          RETURNING id`;
        if (!rows.length) return false;
        const passed = renewal < day;
        await this.notifications.create(tx, {
          recipientId: s.ownerId,
          type: 'renewal_due',
          title: passed ? `${s.vendor} ${s.product} renewal date has passed` : `${s.vendor} ${s.product} renews on ${renewal}`,
          body: `${s.plan}: ${s.currency} ${money(s.cost)}. Record whether it is renewed, changed or cancelled.`,
          link: '/billing/subscriptions',
          dedupeKey: `renewal:${s.id}:${renewal}`,
        });
        await this.outbox.emit({ type: 'billing.subscription.renewal_due', actor: 'system', payload: { subscriptionNumber: s.number, renewsOn: renewal, ownerEmpId: s.owner.empId } }, tx);
        return true;
      });
      if (done) count++;
    }
    return count;
  }
}
