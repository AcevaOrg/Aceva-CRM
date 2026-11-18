import { createHash } from 'node:crypto';
import { Injectable, PayloadTooLargeException } from '@nestjs/common';
import type { EntryView, LedgerBankLineView, ReconciliationView, StatementImportResult, StatementLineView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { isUniqueViolation, withDbRules } from '../common/db-rules';
import { dec, money, ZERO, type Decimal } from '../common/money';
import { addDays, dayOf, dbDate, firstDayOfMonth, lastDayOfMonth } from '../common/pakistan-time';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest, conflict, notFound } from './finance-errors';
import { JournalService } from './journal.service';
import { parseStatement } from './statement-csv';

export const MAX_STATEMENT_BYTES = 2 * 1024 * 1024;
const SUGGEST_DAYS = 3;
const DAY_MS = 86_400_000;

interface BankLine {
  journalLineId: string;
  entryId: string;
  entryNumber: string;
  date: string;
  description: string;
  amount: Decimal;
}

/**
 * Simple bank reconciliation (plan section 13): import the statement (CSV), match each line to a posted ledger line on that
 * bank account, and see what is missing. Amounts are in the bank account's currency (USD lines of a USD account; PKR otherwise).
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
    private readonly clock: Clock,
  ) {}

  private async bank(id: string) {
    const a = await this.prisma.ledgerAccount.findUnique({ where: { id } });
    if (!a || !a.isBank) throw badRequest('unknown_bank_account', 'Choose a bank account');
    return a;
  }

  async import(actor: Actor, bankAccountId: string | undefined, file: { originalname: string; buffer: Buffer; size: number } | undefined, client: RequestInfo): Promise<StatementImportResult> {
    if (!bankAccountId || !/^[0-9a-f-]{36}$/i.test(bankAccountId)) throw badRequest('unknown_bank_account', 'Choose a bank account');
    const bank = await this.bank(bankAccountId);
    if (!file || file.size === 0) throw badRequest('no_file', 'Choose the statement CSV file');
    if (file.size > MAX_STATEMENT_BYTES) throw new PayloadTooLargeException({ statusCode: 413, code: 'file_too_large', message: 'The statement file is too large (limit 2 MB)' });
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const existing = await this.prisma.bankStatementImport.findUnique({ where: { bankAccountId_sha256: { bankAccountId, sha256 } } });
    if (existing) throw conflict('duplicate_statement', `This file was already imported for ${bank.code} on ${existing.createdAt.toISOString().slice(0, 10)}`);
    const text = file.buffer.toString('utf8');
    if (text.includes('\u0000')) throw badRequest('invalid_statement', 'The file is not a CSV text file', { errors: [{ row: 1, message: 'Not a text file' }] });
    const { rows, errors } = parseStatement(text);
    if (errors.length) throw badRequest('invalid_statement', `The statement has ${errors.length} problem(s); nothing was imported`, { errors });
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const imp = await tx.bankStatementImport.create({
          data: {
            bankAccountId,
            filename: file.originalname.split(/[\\/]/).pop()!.slice(0, 200),
            sha256,
            lineCount: rows.length,
            createdBy: actor.id,
            lines: { create: rows.map((r) => ({ lineNo: r.lineNo, valueDate: dbDate(r.date), description: r.description, amount: dec(r.amount), reference: r.reference })) },
          },
        });
        await this.audit.record({ actorId: actor.id, action: 'finance.statement.imported', targetType: 'ledger_account', targetId: bank.code, details: { importId: imp.id, lines: rows.length }, ...client }, tx);
        return imp;
      });
      return { importId: created.id, lineCount: rows.length };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('duplicate_statement', 'This file was already imported for this bank account');
      throw error;
    }
  }

  /** Posted ledger lines on a bank account between two days, signed in the account's currency. */
  private async bankLines(account: { id: string; currency: 'PKR' | 'USD' }, from: string, to: string): Promise<BankLine[]> {
    const lines = await this.prisma.journalLine.findMany({
      where: { accountId: account.id, entry: { status: 'posted', entryDate: { gte: dbDate(from), lte: dbDate(to) }, ...(account.currency === 'USD' ? { currency: 'USD' } : {}) } },
      include: { entry: { select: { id: true, number: true, entryDate: true, description: true } } },
      orderBy: [{ entry: { entryDate: 'asc' } }, { lineNo: 'asc' }],
    });
    return lines.map((l) => ({
      journalLineId: l.id,
      entryId: l.entry.id,
      entryNumber: l.entry.number,
      date: dayOf(l.entry.entryDate),
      description: l.description ?? l.entry.description,
      amount: account.currency === 'USD' ? dec(l.debit).minus(l.credit) : dec(l.baseDebit).minus(l.baseCredit),
    }));
  }

  async view(bankAccountId: string, month: string): Promise<ReconciliationView> {
    const bank = await this.bank(bankAccountId);
    const from = firstDayOfMonth(month);
    const to = lastDayOfMonth(month);
    const statement = await this.prisma.bankStatementLine.findMany({
      where: { statement: { bankAccountId }, valueDate: { gte: dbDate(from), lte: dbDate(to) } },
      include: { matchedLine: { select: { id: true, entry: { select: { id: true, number: true } } } } },
      orderBy: [{ valueDate: 'asc' }, { lineNo: 'asc' }],
    });
    const ledger = await this.bankLines(bank, addDays(from, -SUGGEST_DAYS), addDays(to, SUGGEST_DAYS));
    const matchedIds = new Set(
      (await this.prisma.bankStatementLine.findMany({ where: { matchedLineId: { in: ledger.map((l) => l.journalLineId) } }, select: { matchedLineId: true } })).map((r) => r.matchedLineId!),
    );
    const view = (l: BankLine): LedgerBankLineView => ({ journalLineId: l.journalLineId, entryId: l.entryId, entryNumber: l.entryNumber, date: l.date, description: l.description, amount: money(l.amount), matched: matchedIds.has(l.journalLineId) });
    const lines: StatementLineView[] = statement.map((s) => {
      const amount = dec(s.amount);
      const suggestions = s.matchedLineId
        ? []
        : ledger.filter((l) => !matchedIds.has(l.journalLineId) && l.amount.equals(amount) && Math.abs(Date.parse(l.date) - s.valueDate.getTime()) <= SUGGEST_DAYS * DAY_MS).map(view);
      return {
        id: s.id,
        importId: s.importId,
        lineNo: s.lineNo,
        date: dayOf(s.valueDate),
        description: s.description,
        reference: s.reference,
        amount: money(amount),
        matchedJournalLineId: s.matchedLineId,
        matchedEntryId: s.matchedLine?.entry.id ?? null,
        matchedEntryNumber: s.matchedLine?.entry.number ?? null,
        suggestions,
      };
    });
    const inMonth = ledger.filter((l) => l.date >= from && l.date <= to);
    return {
      bankAccountId,
      month,
      statement: lines,
      ledger: inMonth.map(view),
      missingInLedger: lines.filter((l) => !l.matchedJournalLineId && l.suggestions.length === 0),
      missingInBank: inMonth.filter((l) => !matchedIds.has(l.journalLineId)).map(view),
    };
  }

  async match(actor: Actor, statementLineId: string, journalLineId: string, client: RequestInfo): Promise<StatementLineView> {
    const s = await this.prisma.bankStatementLine.findUnique({ where: { id: statementLineId }, include: { statement: true } });
    if (!s) throw notFound('Statement line');
    if (s.matchedLineId) throw conflict('already_matched', 'This statement line is already matched; unmatch it first');
    const bank = await this.bank(s.statement.bankAccountId);
    const line = await this.prisma.journalLine.findUnique({ where: { id: journalLineId }, include: { entry: { select: { status: true, currency: true, number: true } } } });
    if (!line || line.accountId !== bank.id) throw badRequest('wrong_line', 'Choose a ledger line on this bank account');
    if (line.entry.status !== 'posted') throw badRequest('not_posted', 'Only posted ledger lines can be matched');
    if (bank.currency === 'USD' && line.entry.currency !== 'USD') throw badRequest('wrong_line', 'Choose a USD line of this account');
    const amount = bank.currency === 'USD' ? dec(line.debit).minus(line.credit) : dec(line.baseDebit).minus(line.baseCredit);
    if (!amount.equals(s.amount)) throw badRequest('amount_mismatch', `The ledger line is ${money(amount)}, the statement line ${money(s.amount)}`);
    try {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.bankStatementLine.updateMany({ where: { id: s.id, matchedLineId: null }, data: { matchedLineId: line.id, matchedBy: actor.id, matchedAt: this.clock.now() } });
        if (count === 0) throw conflict('state_changed', 'This statement line changed meanwhile');
        await this.audit.record({ actorId: actor.id, action: 'finance.statement.matched', targetType: 'bank_statement_line', targetId: s.id, details: { entry: line.entry.number }, ...client }, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('already_matched', 'That ledger line is already matched to another statement line');
      throw error;
    }
    return this.lineView(s.id);
  }

  async unmatch(actor: Actor, statementLineId: string, client: RequestInfo): Promise<StatementLineView> {
    const s = await this.prisma.bankStatementLine.findUnique({ where: { id: statementLineId } });
    if (!s) throw notFound('Statement line');
    if (!s.matchedLineId) throw conflict('not_matched', 'This statement line is not matched');
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.bankStatementLine.updateMany({ where: { id: s.id, matchedLineId: s.matchedLineId }, data: { matchedLineId: null, matchedBy: null, matchedAt: null } });
      if (count === 0) throw conflict('state_changed', 'This statement line changed meanwhile');
      await this.audit.record({ actorId: actor.id, action: 'finance.statement.unmatched', targetType: 'bank_statement_line', targetId: s.id, ...client }, tx);
    });
    return this.lineView(s.id);
  }

  /** Accepts every suggestion that is the only candidate for its statement line and suggested for no other line. */
  async autoMatch(actor: Actor, bankAccountId: string, month: string, client: RequestInfo): Promise<{ matched: number }> {
    const v = await this.view(bankAccountId, month);
    const counts = new Map<string, number>();
    for (const l of v.statement) for (const s of l.suggestions) counts.set(s.journalLineId, (counts.get(s.journalLineId) ?? 0) + 1);
    let matched = 0;
    for (const l of v.statement) {
      if (l.matchedJournalLineId || l.suggestions.length !== 1 || counts.get(l.suggestions[0].journalLineId) !== 1) continue;
      await this.match(actor, l.id, l.suggestions[0].journalLineId, client);
      matched++;
    }
    return { matched };
  }

  /** "Missing in ledger": a DRAFT entry prefilled from the statement line (bank vs the chosen account). */
  async createEntry(actor: Actor, statementLineId: string, dto: { counterAccountId: string; description?: string; partyId?: string; submit?: boolean }, client: RequestInfo): Promise<EntryView> {
    const s = await this.prisma.bankStatementLine.findUnique({ where: { id: statementLineId }, include: { statement: true } });
    if (!s) throw notFound('Statement line');
    if (s.matchedLineId) throw conflict('already_matched', 'This statement line is already matched');
    const bank = await this.bank(s.statement.bankAccountId);
    const amount = dec(s.amount).abs();
    const inflow = dec(s.amount).gt(0);
    const description = (dto.description?.trim() || `Bank: ${s.description}`).slice(0, 300);
    const day = dayOf(s.valueDate);
    const ctx = { actorId: actor.id, ...client };
    const id = await withDbRules(() =>
      this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const entry = await this.journal.createDraftTx(
          tx,
          {
            date: day,
            description,
            source: 'manual',
            currency: bank.currency,
            makerId: actor.id,
            lines: [
              { accountId: bank.id, debit: inflow ? amount : ZERO, credit: inflow ? ZERO : amount, description },
              { accountId: dto.counterAccountId, debit: inflow ? ZERO : amount, credit: inflow ? amount : ZERO, partyId: dto.partyId ?? null, description },
            ],
          },
          ctx,
        );
        await this.audit.record({ actorId: actor.id, action: 'finance.statement.entry_created', targetType: 'bank_statement_line', targetId: s.id, details: { entry: entry.number }, ...client }, tx);
        if (dto.submit) await this.journal.submitTx(tx, entry.id, ctx);
        return entry.id;
      }),
    );
    return this.journal.view(actor, id);
  }

  private async lineView(id: string): Promise<StatementLineView> {
    const s = await this.prisma.bankStatementLine.findUniqueOrThrow({ where: { id }, include: { matchedLine: { select: { entry: { select: { id: true, number: true } } } } } });
    return {
      id: s.id,
      importId: s.importId,
      lineNo: s.lineNo,
      date: dayOf(s.valueDate),
      description: s.description,
      reference: s.reference,
      amount: money(s.amount),
      matchedJournalLineId: s.matchedLineId,
      matchedEntryId: s.matchedLine?.entry.id ?? null,
      matchedEntryNumber: s.matchedLine?.entry.number ?? null,
      suggestions: [],
    };
  }

  /** Close check: every imported statement line dated in the month is matched. */
  async unmatchedInMonth(month: string): Promise<{ total: number; unmatched: number }> {
    const where = { valueDate: { gte: dbDate(firstDayOfMonth(month)), lte: dbDate(lastDayOfMonth(month)) } };
    const [total, unmatched] = await Promise.all([this.prisma.bankStatementLine.count({ where }), this.prisma.bankStatementLine.count({ where: { ...where, matchedLineId: null } })]);
    return { total, unmatched };
  }
}
