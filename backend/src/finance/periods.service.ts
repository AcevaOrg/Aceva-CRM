import { Injectable } from '@nestjs/common';
import type { ChecklistItemView, EntryView, PeriodView, RevaluationPreviewView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { StepUpService } from '../auth/step-up.service';
import { Clock } from '../common/clock';
import { isUniqueViolation, withDbRules } from '../common/db-rules';
import { dec, money, round2, sum, ZERO, type Decimal } from '../common/money';
import { dbDate, firstDayOfMonth, lastDayOfMonth, monthOf, pkDate } from '../common/pakistan-time';
import { OutboxService } from '../events/outbox.service';
import type { FinancePeriod, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest, conflict, forbidden, notFound } from './finance-errors';
import { shownStatus } from './finance-views';
import { JournalService, type LineDraft } from './journal.service';
import { LedgerQueryService } from './ledger-query.service';
import { ReconciliationService } from './reconciliation.service';

const LABELS: Record<ChecklistItemView['key'], string> = {
  entries_posted: 'All entries posted',
  bank_reconciled: 'Bank reconciled',
  payroll_posted: 'Payroll posted',
  usd_revalued: 'USD revalued',
  trial_balance: 'Trial balance balanced',
};

/**
 * Month close (plan section 13): a live checklist; the finance duty person runs the close, the CEO approves it (never the
 * person who ran it), and the month's entries are then locked (the database refuses them). Only the Owner or CEO reopen a
 * closed month, with a reason and "confirm again"; the reopening is logged and an alert event is written.
 * Also the month-end USD revaluation. A month without a row is open.
 */
@Injectable()
export class PeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly ledger: LedgerQueryService,
    private readonly recon: ReconciliationService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly stepUp: StepUpService,
    private readonly permissions: PermissionService,
  ) {}

  // ------------------------------------------------------------------------------------------------ checklist

  async checklist(month: string): Promise<ChecklistItemView[]> {
    const from = dbDate(firstDayOfMonth(month));
    const to = dbDate(lastDayOfMonth(month));
    const inMonth = { entryDate: { gte: from, lte: to } };
    const [notPosted, recon, payroll, revaluation, totals, preview] = await Promise.all([
      this.prisma.journalEntry.count({ where: { ...inMonth, status: { in: ['draft', 'pending_approval'] } } }),
      this.recon.unmatchedInMonth(month),
      this.prisma.journalEntry.count({ where: { ...inMonth, source: 'payroll', status: 'posted' } }),
      this.prisma.journalEntry.count({ where: { source: 'revaluation', sourceRef: month, status: 'posted' } }),
      this.ledger.postedTotals(lastDayOfMonth(month)),
      this.usdBalances(month),
    ]);
    const noUsd = preview.every((r) => r.foreign.isZero() && r.bookBase.isZero());
    return [
      { key: 'entries_posted', label: LABELS.entries_posted, done: notPosted === 0, detail: notPosted === 0 ? 'No drafts or entries waiting for approval' : `${notPosted} entr${notPosted === 1 ? 'y is' : 'ies are'} still draft or waiting for approval` },
      {
        key: 'bank_reconciled',
        label: LABELS.bank_reconciled,
        done: recon.unmatched === 0,
        detail: recon.total === 0 ? 'No statement lines imported for this month' : recon.unmatched === 0 ? `All ${recon.total} statement lines matched` : `${recon.unmatched} of ${recon.total} statement lines not matched`,
      },
      { key: 'payroll_posted', label: LABELS.payroll_posted, done: payroll > 0, detail: payroll > 0 ? 'The salary entry is posted' : 'No posted payroll entry dated in this month' },
      {
        key: 'usd_revalued',
        label: LABELS.usd_revalued,
        done: revaluation > 0 || noUsd,
        detail: revaluation > 0 ? 'The revaluation entry is posted' : noUsd ? 'No USD balances to revalue' : 'Run the USD revaluation and get it approved',
      },
      {
        key: 'trial_balance',
        label: LABELS.trial_balance,
        done: totals.debit.equals(totals.credit),
        detail: `Posted debits ${money(totals.debit)} / credits ${money(totals.credit)} up to ${lastDayOfMonth(month)}`,
      },
    ];
  }

  // ------------------------------------------------------------------------------------------------ periods

  async list(actor: Actor): Promise<PeriodView[]> {
    const rows = await this.prisma.financePeriod.findMany();
    const entryMonths = await this.prisma.$queryRaw<Array<{ m: string }>>`SELECT DISTINCT to_char(entry_date, 'YYYY-MM') AS m FROM journal_entries`;
    const months = new Set<string>([...rows.map((r) => r.month), ...entryMonths.map((r) => r.m), monthOf(pkDate(this.clock.now()))]);
    const sorted = [...months].sort((a, b) => b.localeCompare(a)).slice(0, 24);
    return Promise.all(sorted.map((m) => this.get(actor, m)));
  }

  async get(actor: Actor, month: string): Promise<PeriodView> {
    const row = await this.prisma.financePeriod.findUnique({ where: { month }, include: { events: { orderBy: { createdAt: 'asc' } } } });
    const ids = new Set<string>();
    if (row?.closeRequestedBy) ids.add(row.closeRequestedBy);
    if (row?.closedBy) ids.add(row.closedBy);
    for (const e of row?.events ?? []) ids.add(e.actorId);
    const people = new Map((await this.prisma.employee.findMany({ where: { id: { in: [...ids] } }, select: { id: true, empId: true } })).map((p) => [p.id, p.empId]));
    const status = row?.status ?? 'open';
    const reopened = status === 'open' && (row?.events ?? []).some((e) => e.action === 'reopened');
    const mayApprove = status === 'closing' && row?.closeRequestedBy !== actor.id && (await this.permissions.can(actor.id, 'finance.close_approve'));
    return {
      month,
      status: reopened ? 'reopened' : status,
      checklist: await this.checklist(month),
      closeRequestedByEmpId: row?.closeRequestedBy ? (people.get(row.closeRequestedBy) ?? null) : null,
      closeRequestedAt: row?.closeRequestedAt?.toISOString() ?? null,
      closedByEmpId: row?.closedBy ? (people.get(row.closedBy) ?? null) : null,
      closedAt: row?.closedAt?.toISOString() ?? null,
      canApproveClose: mayApprove,
      events: (row?.events ?? []).map((e) => ({ at: e.createdAt.toISOString(), action: e.action, byEmpId: people.get(e.actorId) ?? '', reason: e.reason })),
    };
  }

  private async row(month: string): Promise<FinancePeriod | null> {
    return this.prisma.financePeriod.findUnique({ where: { month } });
  }

  /** The finance duty person runs the close: every checklist item must be done. */
  async close(actor: Actor, month: string, client: RequestInfo): Promise<PeriodView> {
    const existing = await this.row(month);
    if (existing && existing.status !== 'open') throw conflict('invalid_transition', existing.status === 'closed' ? `${month} is already closed` : `${month} is already waiting for close approval`);
    const checklist = await this.checklist(month);
    if (checklist.some((c) => !c.done)) throw conflict('checklist_incomplete', 'The close checklist is not complete', { checklist });
    const now = this.clock.now();
    try {
      await this.prisma.$transaction(async (tx) => {
        const data = { status: 'closing' as const, closeRequestedBy: actor.id, closeRequestedAt: now, checklist: checklist as unknown as Prisma.InputJsonValue, updatedBy: actor.id };
        if (existing) {
          const { count } = await tx.financePeriod.updateMany({ where: { month, status: 'open' }, data });
          if (count === 0) throw conflict('state_changed', 'The month changed meanwhile; reload it');
        } else {
          await tx.financePeriod.create({ data: { month, ...data } });
        }
        await tx.financePeriodEvent.create({ data: { month, action: 'close_requested', actorId: actor.id } });
        await this.audit.record({ actorId: actor.id, action: 'finance.period.close_requested', targetType: 'finance_period', targetId: month, ...client }, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('state_changed', 'The month changed meanwhile; reload it');
      throw error;
    }
    return this.get(actor, month);
  }

  /** The CEO approves the close (finance.close_approve), never the person who ran it. The checklist is checked again. */
  async approveClose(actor: Actor, month: string, client: RequestInfo): Promise<PeriodView> {
    const p = await this.row(month);
    if (!p || p.status !== 'closing') throw conflict('invalid_transition', `${month} is not waiting for close approval`);
    if (p.closeRequestedBy === actor.id) {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'finance_period', targetId: month, outcome: 'denied', reason: 'self_approval', ...client });
      throw forbidden('self_approval', 'You ran this close; a different person approves it');
    }
    const checklist = await this.checklist(month);
    if (checklist.some((c) => !c.done)) throw conflict('checklist_incomplete', 'The close checklist is no longer complete', { checklist });
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.financePeriod.updateMany({ where: { month, status: 'closing' }, data: { status: 'closed', closedBy: actor.id, closedAt: this.clock.now(), checklist: checklist as unknown as Prisma.InputJsonValue, updatedBy: actor.id } });
      if (count === 0) throw conflict('state_changed', 'The month changed meanwhile; reload it');
      await tx.financePeriodEvent.create({ data: { month, action: 'close_approved', actorId: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'finance.period.closed', targetType: 'finance_period', targetId: month, ...client }, tx);
    });
    return this.get(actor, month);
  }

  async rejectClose(actor: Actor, month: string, reason: string, client: RequestInfo): Promise<PeriodView> {
    const p = await this.row(month);
    if (!p || p.status !== 'closing') throw conflict('invalid_transition', `${month} is not waiting for close approval`);
    if (p.closeRequestedBy === actor.id) throw forbidden('self_approval', 'You ran this close; a different person decides it');
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.financePeriod.updateMany({ where: { month, status: 'closing' }, data: { status: 'open', closeRequestedBy: null, closeRequestedAt: null, updatedBy: actor.id } });
      if (count === 0) throw conflict('state_changed', 'The month changed meanwhile; reload it');
      await tx.financePeriodEvent.create({ data: { month, action: 'close_rejected', actorId: actor.id, reason: reason.trim() } });
      await this.audit.record({ actorId: actor.id, action: 'finance.period.close_rejected', targetType: 'finance_period', targetId: month, reason: reason.trim(), ...client }, tx);
    });
    return this.get(actor, month);
  }

  /** Only the Owner or CEO (finance.reopen), with a written reason and "confirm again"; logged and alerted. */
  async reopen(actor: Actor, month: string, reason: string, sessionId: string | null, client: RequestInfo): Promise<PeriodView> {
    const p = await this.row(month);
    if (!p || p.status !== 'closed') throw conflict('invalid_transition', `${month} is not closed`);
    await this.stepUp.require(actor, sessionId, 'finance.period.reopen', { type: 'finance_period', id: month }, client);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.financePeriod.updateMany({ where: { month, status: 'closed' }, data: { status: 'open', closeRequestedBy: null, closeRequestedAt: null, updatedBy: actor.id } });
      if (count === 0) throw conflict('state_changed', 'The month changed meanwhile; reload it');
      await tx.financePeriodEvent.create({ data: { month, action: 'reopened', actorId: actor.id, reason: reason.trim() } });
      await this.audit.record({ actorId: actor.id, action: 'finance.period.reopened', targetType: 'finance_period', targetId: month, reason: reason.trim(), ...client }, tx);
      await this.outbox.emit({ type: 'finance.period.reopened', actor: actor.empId, payload: { month, byEmpId: actor.empId, reason: reason.trim() } }, tx);
    });
    return this.get(actor, month);
  }

  // ------------------------------------------------------------------------------------------------ USD revaluation

  private async usdBalances(month: string) {
    const accounts = await this.prisma.ledgerAccount.findMany({ where: { isBank: true, currency: 'USD' }, orderBy: { code: 'asc' } });
    const balances = await this.ledger.balances({ to: lastDayOfMonth(month) }, accounts.map((a) => a.id));
    return accounts.map((a) => {
      const b = balances.get(a.id);
      return { account: a, foreign: b?.foreign ?? ZERO, bookBase: b ? b.baseDebit.minus(b.baseCredit) : ZERO };
    });
  }

  /** The month-end rate: the one given, else the saved rate for the last day, else the latest saved rate within the month. */
  private async monthEndRate(month: string, given?: string): Promise<Decimal> {
    if (given) return dec(given).toDecimalPlaces(6);
    const row = await this.prisma.exchangeRate.findFirst({
      where: { currency: 'USD', rateDate: { gte: dbDate(firstDayOfMonth(month)), lte: dbDate(lastDayOfMonth(month)) } },
      orderBy: { rateDate: 'desc' },
    });
    if (!row) throw badRequest('rate_missing', `No USD rate is saved for ${month}. Enter the month-end rate.`);
    return dec(row.rate);
  }

  private async existingRevaluation(month: string) {
    return this.prisma.journalEntry.findFirst({
      where: { source: 'revaluation', sourceRef: month, status: { not: 'rejected' } },
      select: { id: true, number: true, status: true, reversedBy: { where: { status: { not: 'rejected' } }, take: 1, select: { status: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revaluationPreview(month: string, rate?: string): Promise<RevaluationPreviewView> {
    const r = await this.monthEndRate(month, rate);
    const rows = (await this.usdBalances(month)).map((b) => {
      const revalued = round2(b.foreign.times(r));
      return { accountId: b.account.id, code: b.account.code, name: b.account.name, foreign: money(b.foreign), bookBase: money(b.bookBase), revaluedBase: money(revalued), difference: money(revalued.minus(b.bookBase)) };
    });
    const existing = await this.existingRevaluation(month);
    return {
      month,
      date: lastDayOfMonth(month),
      rate: r.toFixed(6),
      rows,
      total: money(sum(rows.map((x) => x.difference))),
      existingEntryId: existing?.id ?? null,
      existingEntryNumber: existing?.number ?? null,
      existingEntryStatus: existing ? shownStatus(existing.status, existing.reversedBy[0]?.status) : null,
    };
  }

  /**
   * Posts the difference between each USD bank account's PKR book balance and its USD balance x the month-end rate against the
   * FX gain/loss account, as ONE entry dated the last day of the month (source revaluation, ref = the month). It waits for
   * approval like every entry. Idempotent: an existing revaluation that is not rejected is returned.
   */
  async revalue(actor: Actor, month: string, rate: string | undefined, client: RequestInfo): Promise<EntryView> {
    const existing = await this.existingRevaluation(month);
    if (existing) return this.journal.view(actor, existing.id);
    const preview = await this.revaluationPreview(month, rate);
    const lines: LineDraft[] = [];
    for (const r of preview.rows) {
      const d = dec(r.difference);
      if (d.isZero()) continue;
      const description = `Revaluation of ${r.code}: USD ${r.foreign} at ${preview.rate}`;
      lines.push(d.gt(0) ? { accountId: r.accountId, debit: d, credit: ZERO, description } : { accountId: r.accountId, debit: ZERO, credit: d.abs(), description });
    }
    if (!lines.length) throw conflict('nothing_to_revalue', 'The USD balances already match the month-end rate');
    const net = dec(preview.total);
    const id = await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const fx = await tx.ledgerAccount.findUnique({ where: { systemRole: 'fx_gain_loss' }, select: { id: true } });
        if (!fx) throw conflict('account_role_missing', 'No account has the role "fx_gain_loss". The accountant maps it in the chart of accounts.');
        if (!net.isZero()) lines.push(net.gt(0) ? { accountId: fx.id, debit: ZERO, credit: net, description: 'Exchange gain' } : { accountId: fx.id, debit: net.abs(), credit: ZERO, description: 'Exchange loss' });
        // A rejected revaluation keeps its (source, ref, purpose); a new attempt gets the next purpose number.
        const rejected = await tx.journalEntry.count({ where: { source: 'revaluation', sourceRef: month } });
        const entry = await this.journal.createAndSubmitTx(
          tx,
          {
            date: preview.date,
            description: `Month-end revaluation of USD balances at ${preview.rate} (${month})`,
            source: 'revaluation',
            sourceRef: month,
            purpose: rejected === 0 ? 'revaluation' : `revaluation-${rejected + 1}`,
            currency: 'PKR',
            makerId: actor.id,
            mirror: true,
            lines,
          },
          { actorId: actor.id, ...client },
        );
        await this.audit.record({ actorId: actor.id, action: 'finance.revaluation.created', targetType: 'finance_period', targetId: month, details: { entry: entry.number, rate: preview.rate }, ...client }, tx);
        return entry.id;
      }),
    );
    return this.journal.view(actor, id);
  }

  async assertExists(month: string): Promise<void> {
    if (!(await this.row(month))) throw notFound('Period');
  }
}
