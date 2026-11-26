import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../access/audit.service';
import { Clock } from '../common/clock';
import { dec, money, round2, sum, ZERO, type Decimal } from '../common/money';
import { addDays, dbDate } from '../common/pakistan-time';
import type { Currency, InvoiceKind, Prisma } from '../generated/prisma/client';
import { badRequest, conflict, notFound } from './finance-errors';
import { FinanceDocumentsService } from './finance-documents.service';
import { JournalService, type AuditCtx, type LineDraft } from './journal.service';
import { LedgerQueryService } from './ledger-query.service';

type Tx = Prisma.TransactionClient;

export interface InvoiceLineInput {
  description: string;
  quantity: string;
  unitPrice: string;
  /** The income account credited. */
  accountId: string;
}

export interface DraftInvoiceInput {
  partyId: string;
  kind: InvoiceKind;
  issueDate: string;
  termsDays: number;
  currency: Currency;
  projectId?: string | null;
  notes?: string | null;
  lines: InvoiceLineInput[];
  periodStart?: string | null;
  periodEnd?: string | null;
  recurringRuleId?: string | null;
  reminderOffsets: number[];
  assignedToId?: string | null;
  sourceDealNumber?: string | null;
  sourceDealOwnerId?: string | null;
  requestKey?: string | null;
}

export type DraftInvoiceUpdate = Omit<DraftInvoiceInput, 'kind' | 'recurringRuleId' | 'sourceDealNumber' | 'sourceDealOwnerId' | 'requestKey'>;

/**
 * Module 9's invoice life cycle for Module 13 (one invoice system: Module 13 never writes an invoice, a line, a payment
 * or a ledger entry itself; it calls this service inside its own transaction).
 *
 *  - Draft: a temporary DRAFT- number and NO ledger entry. It can be edited.
 *  - Issue: the invoice gets the next INV-YYYY-NNNN number, its amounts are fixed (a database trigger refuses any later
 *    change) and its ledger entry (Dr receivable / Cr income) is created and submitted. Like every entry it waits for
 *    approval by a different person at the level its amount needs, so issuing never posts money by itself.
 *  - Cancel: a draft is simply cancelled. An issued invoice whose entry is POSTED is cancelled by a reversing entry,
 *    which also waits for approval. An invoice whose entry is still waiting for approval cannot be cancelled (the approver
 *    rejects that entry instead), nor can one that has payments recorded against it.
 */
@Injectable()
export class InvoiceLifecycleService {
  constructor(
    private readonly journal: JournalService,
    private readonly docs: FinanceDocumentsService,
    private readonly ledger: LedgerQueryService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private async lock(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id}::uuid FOR UPDATE`;
    const inv = await tx.invoice.findUnique({ where: { id } });
    if (!inv) throw notFound('Invoice');
    return inv;
  }

  private async preparedLines(tx: Tx, lines: InvoiceLineInput[]) {
    if (!lines.length) throw badRequest('invalid_amount', 'An invoice needs at least one line');
    const out: Array<{ description: string; quantity: Decimal; unitPrice: Decimal; amount: Decimal; accountId: string }> = [];
    for (const l of lines) {
      const account = await this.docs.postingAccount(tx, { accountId: l.accountId }, ['income'], 'income');
      const quantity = dec(l.quantity);
      const unitPrice = dec(l.unitPrice);
      out.push({ description: l.description.trim(), quantity, unitPrice, amount: round2(quantity.times(unitPrice)), accountId: account.id });
    }
    const total = sum(out.map((l) => l.amount));
    if (total.lte(0)) throw badRequest('invalid_amount', 'The invoice total must be more than zero');
    return { lines: out, total };
  }

  /** Creates a draft. No ledger entry. */
  async createDraftTx(tx: Tx, actorId: string | null, input: DraftInvoiceInput, ctx: Omit<AuditCtx, 'actorId'>): Promise<{ id: string; number: string }> {
    const party = await this.docs.partyOf(tx, input.partyId, 'client');
    const { lines, total } = await this.preparedLines(tx, input.lines);
    const number = `DRAFT-${randomUUID().slice(0, 8).toUpperCase()}`;
    const invoice = await tx.invoice.create({
      data: {
        number,
        status: 'draft',
        kind: input.kind,
        partyId: party.id,
        issueDate: dbDate(input.issueDate),
        dueDate: dbDate(addDays(input.issueDate, input.termsDays)),
        termsDays: input.termsDays,
        currency: input.currency,
        exchangeRate: 1,
        total,
        projectId: input.projectId ?? null,
        notes: input.notes?.trim() || null,
        periodStart: input.periodStart ? dbDate(input.periodStart) : null,
        periodEnd: input.periodEnd ? dbDate(input.periodEnd) : null,
        recurringRuleId: input.recurringRuleId ?? null,
        reminderOffsets: [...input.reminderOffsets].sort((a, b) => a - b),
        assignedToId: input.assignedToId ?? null,
        sourceDealNumber: input.sourceDealNumber ?? null,
        sourceDealOwnerId: input.sourceDealOwnerId ?? null,
        requestKey: input.requestKey ?? null,
        createdBy: actorId,
        updatedBy: actorId,
        lines: { create: lines.map((l, i) => ({ lineNo: i + 1, ...l })) },
      },
    });
    await this.audit.record(
      { actorId, action: 'finance.invoice.draft_created', targetType: 'invoice', targetId: invoice.number, details: { kind: input.kind, currency: input.currency, total: money(total), lines: lines.length, sourceDeal: input.sourceDealNumber ?? null, recurring: !!input.recurringRuleId }, ...ctx },
      tx,
    );
    return { id: invoice.id, number: invoice.number };
  }

  /** Replaces the content of a draft. */
  async updateDraftTx(tx: Tx, actorId: string, id: string, input: DraftInvoiceUpdate, ctx: Omit<AuditCtx, 'actorId'>): Promise<void> {
    const inv = await this.lock(tx, id);
    if (inv.status !== 'draft') throw conflict('invalid_transition', 'Only a draft can be edited. An issued invoice is cancelled instead.');
    const party = await this.docs.partyOf(tx, input.partyId, 'client');
    const { lines, total } = await this.preparedLines(tx, input.lines);
    await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
    await tx.invoice.update({
      where: { id },
      data: {
        partyId: party.id,
        issueDate: dbDate(input.issueDate),
        dueDate: dbDate(addDays(input.issueDate, input.termsDays)),
        termsDays: input.termsDays,
        currency: input.currency,
        total,
        projectId: input.projectId ?? null,
        notes: input.notes?.trim() || null,
        periodStart: input.periodStart ? dbDate(input.periodStart) : inv.periodStart,
        reminderOffsets: [...input.reminderOffsets].sort((a, b) => a - b),
        assignedToId: input.assignedToId ?? inv.assignedToId,
        updatedBy: actorId,
        lines: { create: lines.map((l, i) => ({ lineNo: i + 1, ...l })) },
      },
    });
    await this.audit.record({ actorId, action: 'finance.invoice.draft_updated', targetType: 'invoice', targetId: inv.number, details: { total: money(total), lines: lines.length }, ...ctx }, tx);
  }

  /**
   * Issues a draft: real number, fixed amounts, and its ledger entry created and submitted for approval (never posted
   * here). The due date is the issue date plus the payment terms.
   */
  async issueTx(
    tx: Tx,
    actorId: string,
    id: string,
    opts: { issueDate: string; exchangeRate?: string | null },
    ctx: Omit<AuditCtx, 'actorId'>,
  ): Promise<{ number: string; entryNumber: string; issueDate: string; dueDate: string }> {
    const inv = await this.lock(tx, id);
    if (inv.status !== 'draft') throw conflict('invalid_transition', inv.status === 'issued' ? 'This invoice is already issued' : 'A cancelled invoice cannot be issued');
    const party = await this.docs.partyOf(tx, inv.partyId, 'client');
    const current = await tx.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { lineNo: 'asc' } });
    // The accounts are checked again: one may have been archived since the draft was made.
    const { total } = await this.preparedLines(
      tx,
      current.map((l) => ({ description: l.description, quantity: dec(l.quantity).toString(), unitPrice: dec(l.unitPrice).toString(), accountId: l.accountId })),
    );
    await this.journal.assertOpen(tx, opts.issueDate);
    const rate = await this.journal.resolveRate(tx, inv.currency, opts.issueDate, opts.exchangeRate ? dec(opts.exchangeRate) : null);
    const dueDate = addDays(opts.issueDate, inv.termsDays ?? 0);
    const [{ number }] = await tx.$queryRaw<Array<{ number: string }>>`
      SELECT 'INV-' || ${opts.issueDate.slice(0, 4)} || '-' || lpad(nextval('invoice_seq')::text, 4, '0') AS number`;
    await tx.invoice.update({
      where: { id },
      data: { number, status: 'issued', issueDate: dbDate(opts.issueDate), dueDate: dbDate(dueDate), exchangeRate: rate, total, issuedAt: this.clock.now(), issuedBy: actorId, updatedBy: actorId },
    });
    const lines: LineDraft[] = [
      { accountId: await this.docs.roleAccount(tx, 'accounts_receivable'), debit: total, credit: ZERO, partyId: party.id, description: `Invoice ${number}` },
      ...current.map((l) => ({ accountId: l.accountId, debit: ZERO, credit: dec(l.amount), partyId: party.id, description: l.description })),
    ];
    const entry = await this.journal.createAndSubmitTx(
      tx,
      { date: opts.issueDate, description: `Invoice ${number}: ${party.name}`.slice(0, 300), source: 'invoice', sourceRef: id, purpose: 'invoice', currency: inv.currency, exchangeRate: rate, projectId: inv.projectId, makerId: actorId, lines },
      { actorId, ...ctx },
    );
    await tx.invoice.update({ where: { id }, data: { journalEntryId: entry.id } });
    await this.audit.record(
      { actorId, action: 'finance.invoice.issued', targetType: 'invoice', targetId: number, details: { draft: inv.number, entry: entry.number, total: money(total), currency: inv.currency, dueDate }, ...ctx },
      tx,
    );
    return { number, entryNumber: entry.number, issueDate: opts.issueDate, dueDate };
  }

  /**
   * Cancels an invoice. Returns the reversing entry's number when one was needed (the issue entry was posted).
   * A cancelled invoice whose reversing entry was rejected can be cancelled again (a new reversing entry).
   */
  async cancelTx(tx: Tx, actorId: string, id: string, reason: string, ctx: Omit<AuditCtx, 'actorId'>): Promise<{ number: string; reversalNumber: string | null; wasDraft: boolean }> {
    const inv = await this.lock(tx, id);
    const why = reason.trim();
    const done = async (reversal: { id: string; number: string } | null, wasDraft: boolean) => {
      await tx.invoice.update({
        where: { id },
        data: { status: 'cancelled', cancelledAt: this.clock.now(), cancelledBy: actorId, cancelReason: why, cancelEntryId: reversal?.id ?? null, updatedBy: actorId },
      });
      await this.audit.record({ actorId, action: 'finance.invoice.cancelled', targetType: 'invoice', targetId: inv.number, reason: why, details: { reversal: reversal?.number ?? null, wasDraft }, ...ctx }, tx);
      return { number: inv.number, reversalNumber: reversal?.number ?? null, wasDraft };
    };

    if (inv.status === 'draft') return done(null, true);
    if (inv.status === 'cancelled') {
      const prior = inv.cancelEntryId ? await tx.journalEntry.findUnique({ where: { id: inv.cancelEntryId }, select: { status: true } }) : null;
      if (!prior || prior.status !== 'rejected') throw conflict('already_cancelled', 'This invoice is already cancelled');
    }
    if (!inv.journalEntryId) throw conflict('invalid_transition', 'This invoice has no ledger entry');
    const entry = await tx.journalEntry.findUnique({ where: { id: inv.journalEntryId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!entry) throw notFound('Entry');
    if (entry.status === 'pending_approval' || entry.status === 'draft') {
      throw conflict('entry_pending', `Its ledger entry ${entry.number} is still waiting for approval. The approver rejects that entry instead, then the invoice can be cancelled.`);
    }
    const committed = (await this.ledger.allocationTotals('invoice', [id], tx)).get(id)?.committed ?? ZERO;
    if (committed.gt(0)) throw conflict('has_payments', 'Payments are recorded against this invoice, so it cannot be cancelled.');
    if (entry.status === 'rejected') return done(null, false); // nothing was ever posted

    // Posted: a reversing entry (lines swapped, same amounts in PKR), submitted for approval like every entry.
    const day = this.journal.today();
    const reversal = await this.journal.createDraftTx(
      tx,
      {
        date: day,
        description: `Cancellation of invoice ${inv.number}: ${why}`.slice(0, 300),
        source: 'reversal',
        currency: entry.currency,
        exchangeRate: dec(entry.exchangeRate),
        projectId: entry.projectId,
        reversalOfId: entry.id,
        makerId: actorId,
        mirror: true,
        lines: entry.lines.map((l) => ({
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
      { actorId, ...ctx },
    );
    await this.journal.submitTx(tx, reversal.id, { actorId, ...ctx });
    await tx.journalEntryEvent.create({ data: { entryId: entry.id, action: 'reversal_created', actorId, note: `${reversal.number}: invoice ${inv.number} cancelled` } });
    return done({ id: reversal.id, number: reversal.number }, false);
  }

  /** A cancellation whose reversing entry was rejected: the invoice is issued again (the receivable never left the ledger). */
  async restoreTx(tx: Tx, actorId: string, id: string, ctx: Omit<AuditCtx, 'actorId'>): Promise<string> {
    const inv = await this.lock(tx, id);
    const prior = inv.status === 'cancelled' && inv.cancelEntryId ? await tx.journalEntry.findUnique({ where: { id: inv.cancelEntryId }, select: { status: true, number: true } }) : null;
    if (!prior || prior.status !== 'rejected') throw conflict('invalid_transition', 'Only an invoice whose cancellation entry was rejected can be restored');
    await tx.invoice.update({ where: { id }, data: { status: 'issued', cancelledAt: null, cancelledBy: null, cancelReason: null, cancelEntryId: null, updatedBy: actorId } });
    await this.audit.record({ actorId, action: 'finance.invoice.restored', targetType: 'invoice', targetId: inv.number, details: { rejectedReversal: prior.number }, ...ctx }, tx);
    return inv.number;
  }
}
