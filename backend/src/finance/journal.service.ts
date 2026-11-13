import { Injectable } from '@nestjs/common';
import type { EntryListQuery, EntryView } from './finance-views';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { StepUpService } from '../auth/step-up.service';
import { Clock } from '../common/clock';
import { isUniqueViolation, withDbRules } from '../common/db-rules';
import { dec, money, round2, sum, type Decimal } from '../common/money';
import { dayOf, dbDate, firstDayOfMonth, lastDayOfMonth, monthOf, pkDate } from '../common/pakistan-time';
import { OutboxService } from '../events/outbox.service';
import type { Currency, JournalSource, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { labelFor, levelCovers, requiredApprovalLevel, type Tier } from './approval-tier';
import { badRequest, conflict, forbidden, notFound } from './finance-errors';
import { FinanceViews } from './finance-views';

export type Db = Prisma.TransactionClient | PrismaService;

export interface LineDraft {
  accountId: string;
  description?: string | null;
  /** In the entry currency. */
  debit: Decimal;
  credit: Decimal;
  partyId?: string | null;
  employeeId?: string | null;
  /** Internal only (reversals, transfers between currencies, revaluation): the exact PKR amount of the line. */
  baseDebit?: Decimal;
  baseCredit?: Decimal;
}

export interface DraftInput {
  date: string;
  description: string;
  source: JournalSource;
  sourceRef?: string | null;
  purpose?: string | null;
  currency: Currency;
  /** PKR per 1 unit of the entry currency; USD without it = the saved rate for the date. */
  exchangeRate?: Decimal | null;
  projectId?: string | null;
  reversalOfId?: string | null;
  makerId: string;
  lines: LineDraft[];
  /**
   * A system entry that copies or adjusts existing ledger amounts (a reversal, a USD revaluation): archived accounts and
   * PKR lines on USD accounts are accepted, because the entry mirrors what is already in the books.
   */
  mirror?: boolean;
}

export interface AuditCtx {
  actorId: string;
  ip?: string | null;
  userAgent?: string | null;
}

interface PreparedLine {
  accountId: string;
  description: string | null;
  debit: Decimal;
  credit: Decimal;
  baseDebit: Decimal;
  baseCredit: Decimal;
  partyId: string | null;
  employeeId: string | null;
}

/**
 * The journal core (plan section 13). Every entry, manual or created by an invoice, bill, payment, payroll or revaluation,
 * goes through here: Draft -> submit -> Pending approval -> approve = Posted, or reject (with a reason) = Rejected.
 * Debits must equal credits (checked here, and again by the database at commit). A posted entry is never edited; it is
 * corrected by a reversing entry that follows the same approval. Every status change writes the entry history and the
 * audit log in the same transaction.
 */
@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly stepUp: StepUpService,
    private readonly permissions: PermissionService,
    private readonly views: FinanceViews,
  ) {}

  today(): string {
    return pkDate(this.clock.now());
  }

  // --------------------------------------------------------------------------------------------------------- shared rules

  /**
   * A closed month takes no entries (the database refuses them too). A month waiting for its close approval takes none
   * either: the checklist was complete when the close was asked for, and a new entry would be stranded in a closed month
   * (security review, finding 7). The CEO rejects the close to reopen it for entries.
   */
  async assertOpen(db: Db, day: string): Promise<void> {
    const month = monthOf(day);
    const period = await db.financePeriod.findUnique({ where: { month }, select: { status: true } });
    if (period?.status === 'closed') throw conflict('period_closed', `${month} is closed. Ask the Owner or CEO to reopen it.`);
    if (period?.status === 'closing') throw conflict('period_closing', `${month} is waiting for its close approval. New entries wait until the close is approved or rejected.`);
  }

  async tiers(db: Db): Promise<Tier[]> {
    const rows = await db.approvalLimit.findMany({ orderBy: { approverLevel: 'desc' } });
    return rows.map((r) => ({ approverLevel: r.approverLevel, maxAmount: r.maxAmount === null ? null : dec(r.maxAmount), label: r.label }));
  }

  async stepUpAbove(db: Db): Promise<Decimal> {
    const row = await db.financeSetting.findUnique({ where: { id: 1 } });
    if (!row) throw conflict('finance_settings_missing', 'Finance settings are not set up');
    return dec(row.stepUpAbove);
  }

  /** USD rate saved for a day (PKR per 1 USD), or null. */
  async savedRate(db: Db, day: string): Promise<Decimal | null> {
    const row = await db.exchangeRate.findUnique({ where: { currency_rateDate: { currency: 'USD', rateDate: dbDate(day) } } });
    return row ? dec(row.rate) : null;
  }

  async resolveRate(db: Db, currency: Currency, day: string, given?: Decimal | null): Promise<Decimal> {
    if (currency === 'PKR') {
      if (given && !dec(given).equals(1)) throw badRequest('invalid_rate', 'A PKR entry has the rate 1');
      return dec(1);
    }
    if (given) {
      if (dec(given).lessThanOrEqualTo(0)) throw badRequest('invalid_rate', 'The rate must be more than zero');
      return dec(given).toDecimalPlaces(6);
    }
    const saved = await this.savedRate(db, day);
    if (!saved) throw badRequest('rate_missing', `No USD rate is saved for ${day}. Enter the rate on the entry or save the day's rate first.`);
    return saved;
  }

  /** Validates the lines and works out their PKR amounts. Throws a clear 400 for every problem. */
  async prepare(db: Db, input: DraftInput): Promise<{ rate: Decimal; lines: PreparedLine[]; total: Decimal; totalBase: Decimal }> {
    if (input.lines.length < 2) throw badRequest('unbalanced_entry', 'An entry needs at least two lines');
    for (const [i, l] of input.lines.entries()) {
      const d = dec(l.debit);
      const c = dec(l.credit);
      if (d.isNegative() || c.isNegative() || d.gt(0) === c.gt(0)) throw badRequest('invalid_line', `Line ${i + 1}: a line has a debit or a credit (one of them, more than zero)`);
      if (d.decimalPlaces() > 2 || c.decimalPlaces() > 2) throw badRequest('invalid_line', `Line ${i + 1}: amounts have at most 2 decimals`);
    }
    const totalDebit = sum(input.lines.map((l) => l.debit));
    const totalCredit = sum(input.lines.map((l) => l.credit));
    if (!totalDebit.equals(totalCredit)) {
      throw badRequest('unbalanced_entry', `Total debits (${money(totalDebit)}) must equal total credits (${money(totalCredit)})`);
    }

    const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
    const accounts = await db.ledgerAccount.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, code: true, archivedAt: true, currency: true, children: { where: { archivedAt: null }, select: { id: true }, take: 1 } },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const id of accountIds) {
      const a = byId.get(id);
      if (!a) throw badRequest('unknown_account', 'An account on a line does not exist');
      if (!input.mirror && a.archivedAt) throw badRequest('account_archived', `Account ${a.code} is archived`);
      if (a.children.length) throw badRequest('header_account', `Account ${a.code} groups other accounts and takes no postings`);
      if (!input.mirror && input.currency === 'PKR' && a.currency === 'USD') {
        throw badRequest('currency_mismatch', `Account ${a.code} is a USD account: enter the entry in USD with its rate`);
      }
    }
    const partyIds = [...new Set(input.lines.map((l) => l.partyId).filter((p): p is string => !!p))];
    if (partyIds.length) {
      const found = await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, archivedAt: true } });
      if (found.length !== partyIds.length || (!input.mirror && found.some((p) => p.archivedAt))) throw badRequest('unknown_party', 'A client or vendor on a line does not exist or is archived');
    }
    const employeeIds = [...new Set(input.lines.map((l) => l.employeeId).filter((p): p is string => !!p))];
    if (employeeIds.length) {
      const found = await db.employee.count({ where: { id: { in: employeeIds } } });
      if (found !== employeeIds.length) throw badRequest('unknown_employee', 'An employee on a line does not exist');
    }
    if (input.projectId) {
      const project = await db.financeProject.findUnique({ where: { id: input.projectId }, select: { archivedAt: true } });
      if (!project || (!input.mirror && project.archivedAt)) throw badRequest('unknown_project', 'The project does not exist or is archived');
    }

    const rate = await this.resolveRate(db, input.currency, input.date, input.exchangeRate);
    const lines: PreparedLine[] = input.lines.map((l) => ({
      accountId: l.accountId,
      description: l.description?.trim() || null,
      debit: dec(l.debit),
      credit: dec(l.credit),
      baseDebit: l.baseDebit !== undefined ? round2(l.baseDebit) : round2(dec(l.debit).times(rate)),
      baseCredit: l.baseCredit !== undefined ? round2(l.baseCredit) : round2(dec(l.credit).times(rate)),
      partyId: l.partyId ?? null,
      employeeId: l.employeeId ?? null,
    }));
    // Rounding each line to paisa can leave the PKR sides a few paisa apart: the largest line on the smaller side absorbs it.
    const bd = sum(lines.map((l) => l.baseDebit));
    const bc = sum(lines.map((l) => l.baseCredit));
    if (!bd.equals(bc)) {
      const diff = bd.minus(bc);
      const creditSide = diff.gt(0);
      const side = lines.filter((l) => (creditSide ? l.credit.gt(0) : l.debit.gt(0)));
      const target = side.reduce((m, l) => ((creditSide ? l.baseCredit : l.baseDebit).gt(creditSide ? m.baseCredit : m.baseDebit) ? l : m), side[0]);
      if (creditSide) target.baseCredit = target.baseCredit.plus(diff.abs());
      else target.baseDebit = target.baseDebit.plus(diff.abs());
      const note = `PKR rounding adjusted by ${money(diff.abs())}`;
      target.description = target.description ? `${target.description} (${note})` : note;
    }
    const totalBase = sum(lines.map((l) => l.baseDebit));
    if (totalBase.lte(0)) throw badRequest('unbalanced_entry', 'The entry total must be more than zero');
    return { rate, lines, total: totalDebit, totalBase };
  }

  // --------------------------------------------------------------------------------------------------------- write steps (inside a transaction)

  async createDraftTx(tx: Prisma.TransactionClient, input: DraftInput, ctx: AuditCtx) {
    await this.assertOpen(tx, input.date);
    const p = await this.prepare(tx, input);
    const entry = await tx.journalEntry.create({
      data: {
        entryDate: dbDate(input.date),
        description: input.description.trim(),
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        purpose: input.purpose ?? null,
        currency: input.currency,
        exchangeRate: p.rate,
        totalBase: p.totalBase,
        status: 'draft',
        projectId: input.projectId ?? null,
        reversalOfId: input.reversalOfId ?? null,
        makerId: input.makerId,
        createdBy: ctx.actorId,
        updatedBy: ctx.actorId,
      },
    });
    await tx.journalLine.createMany({ data: p.lines.map((l, i) => ({ entryId: entry.id, lineNo: i + 1, ...l })) });
    await tx.journalEntryEvent.create({ data: { entryId: entry.id, action: 'created', actorId: ctx.actorId, note: input.source === 'manual' ? null : `Created from ${input.source}` } });
    await this.audit.record(
      { actorId: ctx.actorId, action: 'finance.entry.created', targetType: 'journal_entry', targetId: entry.number, details: { source: input.source, currency: input.currency, lines: p.lines.length }, ip: ctx.ip, userAgent: ctx.userAgent },
      tx,
    );
    return entry;
  }

  /** Draft -> Pending approval, with the approval tier the amount needs stored on the entry. */
  async submitTx(tx: Prisma.TransactionClient, entryId: string, ctx: AuditCtx): Promise<{ id: string; number: string; requiredLevel: number }> {
    const e = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { lines: { include: { account: { select: { requiresOwnerApproval: true } } } } } });
    if (!e) throw notFound('Entry');
    if (e.status !== 'draft') throw conflict('invalid_transition', 'Only a draft can be submitted');
    await this.assertOpen(tx, dayOf(e.entryDate));
    const d = sum(e.lines.map((l) => l.debit));
    const c = sum(e.lines.map((l) => l.credit));
    const bd = sum(e.lines.map((l) => l.baseDebit));
    const bc = sum(e.lines.map((l) => l.baseCredit));
    if (e.lines.length < 2 || !d.equals(c) || !bd.equals(bc) || !bd.equals(e.totalBase) || d.lte(0)) {
      throw badRequest('unbalanced_entry', 'Total debits must equal total credits');
    }
    const maker = await tx.employee.findUnique({ where: { id: e.makerId }, select: { level: { select: { number: true } } } });
    const tier = requiredApprovalLevel(bd, await this.tiers(tx), e.lines.some((l) => l.account.requiresOwnerApproval), maker?.level.number ?? null);
    if (!tier.ok) {
      throw tier.reason === 'no_tier'
        ? conflict('approval_limits_missing', 'No approval limit covers this amount; settings must be completed')
        : conflict('no_eligible_approver', 'Nobody is senior enough to approve an entry made by its maker');
    }
    const { count } = await tx.journalEntry.updateMany({
      where: { id: entryId, status: 'draft' },
      data: { status: 'pending_approval', submittedAt: this.clock.now(), requiredLevel: tier.level, updatedBy: ctx.actorId },
    });
    if (count === 0) throw conflict('state_changed', 'This entry changed meanwhile; reload it');
    await tx.journalEntryEvent.create({ data: { entryId, action: 'submitted', actorId: ctx.actorId, note: `Needs ${tier.label} approval (level ${tier.level})` } });
    await this.audit.record(
      { actorId: ctx.actorId, action: 'finance.entry.submitted', targetType: 'journal_entry', targetId: e.number, details: { requiredLevel: tier.level }, ip: ctx.ip, userAgent: ctx.userAgent },
      tx,
    );
    return { id: e.id, number: e.number, requiredLevel: tier.level };
  }

  /** Creates a draft and submits it in the same transaction (invoices, bills, payments, transfers, payroll). */
  async createAndSubmitTx(tx: Prisma.TransactionClient, input: DraftInput, ctx: AuditCtx) {
    const entry = await this.createDraftTx(tx, input, ctx);
    await this.submitTx(tx, entry.id, ctx);
    return entry;
  }

  // --------------------------------------------------------------------------------------------------------- API actions

  async create(actor: Actor, dto: ManualEntryDto, client: RequestInfo): Promise<EntryView> {
    const ctx = { actorId: actor.id, ...client };
    const lines = await this.apiLines(dto.lines);
    const id = await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const entry = await this.createDraftTx(tx, { ...this.headerOf(dto), source: 'manual', makerId: actor.id, lines }, ctx);
        if (dto.submit) await this.submitTx(tx, entry.id, ctx);
        return entry.id;
      }),
    );
    return this.view(actor, id);
  }

  async update(actor: Actor, id: string, dto: Omit<ManualEntryDto, 'submit'>, client: RequestInfo): Promise<EntryView> {
    const lines = await this.apiLines(dto.lines);
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const e = await tx.journalEntry.findUnique({ where: { id } });
        if (!e) throw notFound('Entry');
        if (e.status !== 'draft') throw conflict('invalid_transition', 'Only a draft can be edited; a posted entry is reversed instead');
        if (e.makerId !== actor.id) throw forbidden('not_maker', 'Only the person who made this draft can change it');
        if (e.source !== 'manual') throw conflict('invalid_transition', 'An entry created by the system cannot be edited by hand');
        await this.assertOpen(tx, dayOf(e.entryDate));
        const header = this.headerOf(dto);
        await this.assertOpen(tx, header.date);
        const p = await this.prepare(tx, { ...header, source: 'manual', makerId: e.makerId, lines });
        await tx.journalLine.deleteMany({ where: { entryId: id } });
        const { count } = await tx.journalEntry.updateMany({
          where: { id, status: 'draft' },
          data: {
            entryDate: dbDate(header.date),
            description: header.description,
            currency: header.currency,
            exchangeRate: p.rate,
            totalBase: p.totalBase,
            projectId: header.projectId,
            updatedBy: actor.id,
          },
        });
        if (count === 0) throw conflict('state_changed', 'This entry changed meanwhile; reload it');
        await tx.journalLine.createMany({ data: p.lines.map((l, i) => ({ entryId: id, lineNo: i + 1, ...l })) });
        await tx.journalEntryEvent.create({ data: { entryId: id, action: 'edited', actorId: actor.id } });
        await this.audit.record({ actorId: actor.id, action: 'finance.entry.updated', targetType: 'journal_entry', targetId: e.number, details: { lines: p.lines.length }, ...client }, tx);
      }),
    );
    return this.view(actor, id);
  }

  async submit(actor: Actor, id: string, client: RequestInfo): Promise<EntryView> {
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const e = await tx.journalEntry.findUnique({ where: { id }, select: { makerId: true } });
        if (!e) throw notFound('Entry');
        if (e.makerId !== actor.id) throw forbidden('not_maker', 'Only the person who made this draft can submit it');
        await this.submitTx(tx, id, { actorId: actor.id, ...client });
      }),
    );
    return this.view(actor, id);
  }

  /** Approve = Posted (plan: "Once approved it is Posted to the ledger"). */
  async approve(actor: Actor, id: string, note: string | undefined, sessionId: string | null, client: RequestInfo): Promise<EntryView> {
    const e = await this.prisma.journalEntry.findUnique({ where: { id } });
    if (!e) throw notFound('Entry');
    if (e.status !== 'pending_approval') throw conflict('invalid_transition', 'Only an entry waiting for approval can be approved');
    await this.assertMayDecide(actor, e, 'approve', client);
    await this.assertOpen(this.prisma, dayOf(e.entryDate));
    if (dec(e.totalBase).gt(await this.stepUpAbove(this.prisma))) {
      // Plan section 16: posting large entries asks for the password (and code) again.
      await this.stepUp.require(actor, sessionId, 'finance.entry.approve', { type: 'journal_entry', id: e.number }, client);
    }
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const now = this.clock.now();
        const { count } = await tx.journalEntry.updateMany({
          where: { id, status: 'pending_approval' },
          data: { status: 'posted', approvedBy: actor.id, postedAt: now, updatedBy: actor.id },
        });
        if (count === 0) throw conflict('state_changed', 'This entry was already decided');
        await tx.journalEntryEvent.create({ data: { entryId: id, action: 'approved', actorId: actor.id, note: note?.trim() || null } });
        await tx.journalEntryEvent.create({ data: { entryId: id, action: 'posted', actorId: actor.id } });
        await this.audit.record(
          { actorId: actor.id, action: 'finance.entry.approved', targetType: 'journal_entry', targetId: e.number, details: { requiredLevel: e.requiredLevel, approverLevel: actor.levelNumber, source: e.source }, ...client },
          tx,
        );
        await this.outbox.emit({ type: 'ledger.entry.posted', actor: actor.empId, payload: { entryNumber: e.number, source: e.source, entryDate: dayOf(e.entryDate) } }, tx);
      }),
    );
    return this.view(actor, id);
  }

  async reject(actor: Actor, id: string, reason: string, client: RequestInfo): Promise<EntryView> {
    const e = await this.prisma.journalEntry.findUnique({ where: { id } });
    if (!e) throw notFound('Entry');
    if (e.status !== 'pending_approval') throw conflict('invalid_transition', 'Only an entry waiting for approval can be rejected');
    await this.assertMayDecide(actor, e, 'reject', client);
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const { count } = await tx.journalEntry.updateMany({
          where: { id, status: 'pending_approval' },
          data: { status: 'rejected', rejectedBy: actor.id, rejectedReason: reason.trim(), updatedBy: actor.id },
        });
        if (count === 0) throw conflict('state_changed', 'This entry was already decided');
        await tx.journalEntryEvent.create({ data: { entryId: id, action: 'rejected', actorId: actor.id, note: reason.trim() } });
        await this.audit.record({ actorId: actor.id, action: 'finance.entry.rejected', targetType: 'journal_entry', targetId: e.number, reason: reason.trim(), details: { requiredLevel: e.requiredLevel }, ...client }, tx);
      }),
    );
    return this.view(actor, id);
  }

  /** A posted entry is corrected by a reversing DRAFT (lines swapped) that then follows the normal approval. Once per entry. */
  async reverse(actor: Actor, id: string, reason: string, date: string | undefined, client: RequestInfo): Promise<EntryView> {
    const ctx = { actorId: actor.id, ...client };
    const reversalId = await withDbRules(async () => {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const e = await tx.journalEntry.findUnique({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } }, reversedBy: { where: { status: { not: 'rejected' } }, take: 1, select: { id: true } } } });
          if (!e) throw notFound('Entry');
          if (e.status !== 'posted') throw conflict('invalid_transition', 'Only a posted entry can be reversed');
          if (e.reversedBy.length > 0) throw conflict('already_reversed', 'This entry already has a reversing entry');
          const day = date ?? this.today();
          const draft = await this.createDraftTx(
            tx,
            {
              date: day,
              description: `Reversal of ${e.number}: ${reason.trim()}`.slice(0, 300),
              source: 'reversal',
              currency: e.currency,
              exchangeRate: dec(e.exchangeRate),
              projectId: e.projectId,
              reversalOfId: e.id,
              makerId: actor.id,
              mirror: true,
              lines: e.lines.map((l) => ({
                accountId: l.accountId,
                description: l.description,
                debit: dec(l.credit),
                credit: dec(l.debit),
                baseDebit: dec(l.baseCredit),
                baseCredit: dec(l.baseDebit),
                partyId: l.partyId,
                employeeId: l.employeeId,
              })),
            },
            ctx,
          );
          await tx.journalEntryEvent.create({ data: { entryId: e.id, action: 'reversal_created', actorId: actor.id, note: `${draft.number}: ${reason.trim()}` } });
          await this.audit.record({ actorId: actor.id, action: 'finance.entry.reversal_created', targetType: 'journal_entry', targetId: e.number, reason: reason.trim(), details: { reversal: draft.number }, ...client }, tx);
          return draft.id;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('already_reversed', 'This entry already has a reversing entry');
        throw error;
      }
    });
    return this.view(actor, reversalId);
  }

  private async assertMayDecide(actor: Actor, e: { id: string; makerId: string; number: string; requiredLevel: number | null }, what: 'approve' | 'reject', client: RequestInfo): Promise<void> {
    const deny = async (reason: string, err: Error): Promise<never> => {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'journal_entry', targetId: e.number, outcome: 'denied', reason, details: { attempted: what }, ...client });
      throw err;
    };
    if (e.makerId === actor.id) await deny('self_approval', forbidden('self_approval', 'You made this entry; a different person decides it'));
    // The tier is stored at submit; an account flagged "Owner approves" since then still needs the Owner (security review, finding 1).
    const ownerNow = (await this.prisma.journalLine.count({ where: { entryId: e.id, account: { requiresOwnerApproval: true } } })) > 0;
    const required = Math.min(e.requiredLevel ?? 1, ownerNow ? 1 : Number.MAX_SAFE_INTEGER);
    if (!levelCovers(actor.levelNumber, required)) {
      await deny('approval_limit', forbidden('approval_limit', `This entry needs ${labelFor(required, await this.tiers(this.prisma))} approval (level ${required} or higher)`));
    }
  }

  // --------------------------------------------------------------------------------------------------------- reads

  async list(actor: Actor, q: EntryListQuery) {
    const where: Prisma.JournalEntryWhereInput = {};
    const and: Prisma.JournalEntryWhereInput[] = [];
    if (q.status && q.status !== 'all') {
      if (q.status === 'reversed') and.push({ status: 'posted', reversedBy: { some: { status: 'posted' } } });
      else if (q.status === 'posted') and.push({ status: 'posted', NOT: { reversedBy: { some: { status: 'posted' } } } });
      else and.push({ status: q.status });
    }
    if (q.month) and.push({ entryDate: { gte: dbDate(firstDayOfMonth(q.month)), lte: dbDate(lastDayOfMonth(q.month)) } });
    if (q.source && q.source !== 'all') and.push({ source: q.source });
    if (q.accountId) and.push({ lines: { some: { accountId: q.accountId } } });
    if (q.partyId) and.push({ lines: { some: { partyId: q.partyId } } });
    if (q.projectId) and.push({ projectId: q.projectId });
    if (q.q) and.push({ OR: [{ number: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }] });
    if (q.awaitingMe === 'true') {
      const canApprove = await this.permissions.can(actor.id, 'finance.entry_approve');
      if (!canApprove) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
      and.push({ status: 'pending_approval', makerId: { not: actor.id }, requiredLevel: { gte: actor.levelNumber } });
    }
    if (and.length) where.AND = and;
    const [total, rows] = await Promise.all([
      this.prisma.journalEntry.count({ where }),
      this.prisma.journalEntry.findMany({ where, orderBy: [{ entryDate: 'desc' }, { number: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
    ]);
    const items = await this.views.entries(actor, rows.map((r) => r.id));
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async view(actor: Actor, id: string): Promise<EntryView> {
    const [v] = await this.views.entries(actor, [id]);
    if (!v) throw notFound('Entry');
    return v;
  }

  // --------------------------------------------------------------------------------------------------------- helpers

  private headerOf(dto: Omit<ManualEntryDto, 'submit'>) {
    return {
      date: dto.date,
      description: dto.description.trim(),
      currency: dto.currency,
      exchangeRate: dto.exchangeRate ? dec(dto.exchangeRate) : null,
      projectId: dto.projectId ?? null,
    };
  }

  /** API lines use Emp-IDs; the ledger stores the employee UUID. */
  private async apiLines(lines: ManualEntryDto['lines']): Promise<LineDraft[]> {
    const empIds = [...new Set(lines.map((l) => l.empId).filter((x): x is string => !!x))];
    const employees = empIds.length ? await this.prisma.employee.findMany({ where: { empId: { in: empIds } }, select: { id: true, empId: true } }) : [];
    const byEmp = new Map(employees.map((e) => [e.empId, e.id]));
    return lines.map((l) => {
      if (l.empId && !byEmp.has(l.empId)) throw badRequest('unknown_employee', `Employee ${l.empId} does not exist`);
      return {
        accountId: l.accountId,
        description: l.description ?? null,
        debit: dec(l.debit ?? 0),
        credit: dec(l.credit ?? 0),
        partyId: l.partyId ?? null,
        employeeId: l.empId ? byEmp.get(l.empId)! : null,
      };
    });
  }
}

export interface ManualEntryDto {
  date: string;
  description: string;
  projectId?: string;
  currency: Currency;
  exchangeRate?: string;
  lines: Array<{ accountId: string; description?: string; debit?: string; credit?: string; partyId?: string; empId?: string }>;
  submit?: boolean;
}


