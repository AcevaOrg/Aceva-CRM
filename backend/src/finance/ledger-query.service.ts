import { Injectable } from '@nestjs/common';
import type { AgingView, BillsDueView, GeneralLedgerView, ProfitView, TrialBalanceView } from '@aceva/contracts';
import { dec, money, sum, ZERO, type Decimal } from '../common/money';
import { dayOf, dbDate } from '../common/pakistan-time';
import type { AccountGroup, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { notFound } from './finance-errors';

export interface Balance {
  baseDebit: Decimal;
  baseCredit: Decimal;
  /** Debit minus credit of the lines of USD entries, in USD. */
  foreign: Decimal;
}

type Db = PrismaService | Prisma.TransactionClient;

/** +1 when the account's natural balance is a debit (assets, expenses). */
export const naturalSign = (group: AccountGroup) => (group === 'asset' || group === 'expense' ? 1 : -1);

const DAY_MS = 86_400_000;
const daysFrom = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Read-only ledger queries (balances, trial balance, general ledger, aging, profit). Everything is read from POSTED lines only;
 * drafts, entries waiting for approval and rejected entries never count. Module 10 (statements) reuses this service.
 */
@Injectable()
export class LedgerQueryService {
  constructor(private readonly prisma: PrismaService) {}

  private postedWhere(range: { from?: string; to?: string }, extra: Prisma.JournalEntryWhereInput = {}): Prisma.JournalEntryWhereInput {
    const entryDate: Prisma.DateTimeFilter = {};
    if (range.from) entryDate.gte = dbDate(range.from);
    if (range.to) entryDate.lte = dbDate(range.to);
    return { status: 'posted', ...(range.from || range.to ? { entryDate } : {}), ...extra };
  }

  /** Posted totals per account, optionally within a date range and for some accounts. */
  async balances(range: { from?: string; to?: string } = {}, accountIds?: string[], db: Db = this.prisma): Promise<Map<string, Balance>> {
    const where: Prisma.JournalLineWhereInput = { entry: this.postedWhere(range), ...(accountIds ? { accountId: { in: accountIds } } : {}) };
    const [base, foreign] = await Promise.all([
      db.journalLine.groupBy({ by: ['accountId'], where, _sum: { baseDebit: true, baseCredit: true } }),
      db.journalLine.groupBy({ by: ['accountId'], where: { ...where, entry: this.postedWhere(range, { currency: 'USD' }) }, _sum: { debit: true, credit: true } }),
    ]);
    const map = new Map<string, Balance>();
    for (const b of base) map.set(b.accountId, { baseDebit: dec(b._sum.baseDebit), baseCredit: dec(b._sum.baseCredit), foreign: ZERO });
    for (const f of foreign) {
      const cur = map.get(f.accountId) ?? { baseDebit: ZERO, baseCredit: ZERO, foreign: ZERO };
      cur.foreign = dec(f._sum.debit).minus(dec(f._sum.credit));
      map.set(f.accountId, cur);
    }
    return map;
  }

  async trialBalance(date: string): Promise<TrialBalanceView> {
    const [accounts, balances] = await Promise.all([this.prisma.ledgerAccount.findMany({ orderBy: { code: 'asc' } }), this.balances({ to: date })]);
    const rows: TrialBalanceView['rows'] = [];
    for (const a of accounts) {
      const b = balances.get(a.id);
      if (!b) continue;
      const net = b.baseDebit.minus(b.baseCredit);
      if (net.isZero()) continue;
      rows.push({ accountId: a.id, code: a.code, name: a.name, group: a.group, debit: money(net.gt(0) ? net : 0), credit: money(net.lt(0) ? net.abs() : 0) });
    }
    const totalDebit = sum(rows.map((r) => r.debit));
    const totalCredit = sum(rows.map((r) => r.credit));
    return { date, rows, totalDebit: money(totalDebit), totalCredit: money(totalCredit), balanced: totalDebit.equals(totalCredit) };
  }

  /** Posted PKR debits and credits up to a day (the "trial balance balanced" close check). */
  async postedTotals(to: string, db: Db = this.prisma): Promise<{ debit: Decimal; credit: Decimal }> {
    const r = await db.journalLine.aggregate({ where: { entry: this.postedWhere({ to }) }, _sum: { baseDebit: true, baseCredit: true } });
    return { debit: dec(r._sum.baseDebit), credit: dec(r._sum.baseCredit) };
  }

  async generalLedger(accountId: string, from: string, to: string): Promise<GeneralLedgerView> {
    const account = await this.prisma.ledgerAccount.findUnique({ where: { id: accountId } });
    if (!account) throw notFound('Account');
    const sign = naturalSign(account.group);
    const before = await this.prisma.journalLine.aggregate({
      where: { accountId, entry: { status: 'posted', entryDate: { lt: dbDate(from) } } },
      _sum: { baseDebit: true, baseCredit: true },
    });
    const opening = dec(before._sum.baseDebit).minus(dec(before._sum.baseCredit)).times(sign);
    const lines = await this.prisma.journalLine.findMany({
      where: { accountId, entry: this.postedWhere({ from, to }) },
      include: { entry: { select: { id: true, number: true, entryDate: true, description: true } } },
      orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { number: 'asc' } }, { lineNo: 'asc' }],
    });
    let running = opening;
    const out = lines.map((l) => {
      running = running.plus(dec(l.baseDebit).minus(l.baseCredit).times(sign));
      return {
        date: dayOf(l.entry.entryDate),
        entryId: l.entry.id,
        entryNumber: l.entry.number,
        description: l.description ?? l.entry.description,
        debit: money(l.baseDebit),
        credit: money(l.baseCredit),
        balance: money(running),
      };
    });
    return { accountId, code: account.code, name: account.name, from, to, opening: money(opening), lines: out, closing: money(running) };
  }

  /**
   * What has been paid on invoices / bills: `paid` counts allocations of payments whose entries are POSTED; `committed` counts
   * every allocation whose payment entry is not rejected (so the same open amount cannot be allocated twice).
   */
  async allocationTotals(kind: 'invoice' | 'bill', ids: string[], db: Db = this.prisma): Promise<Map<string, { paid: Decimal; committed: Decimal }>> {
    const map = new Map<string, { paid: Decimal; committed: Decimal }>();
    if (!ids.length) return map;
    const field = kind === 'invoice' ? 'invoiceId' : 'billId';
    const rows = await db.paymentAllocation.findMany({
      where: { [field]: { in: ids } },
      select: { invoiceId: true, billId: true, amount: true, payment: { select: { journalEntryId: true } } },
    });
    const entryIds = [...new Set(rows.map((r) => r.payment.journalEntryId).filter((x): x is string => !!x))];
    const entries = entryIds.length ? await db.journalEntry.findMany({ where: { id: { in: entryIds } }, select: { id: true, status: true } }) : [];
    const status = new Map(entries.map((e) => [e.id, e.status]));
    for (const r of rows) {
      const id = (kind === 'invoice' ? r.invoiceId : r.billId)!;
      const s = r.payment.journalEntryId ? status.get(r.payment.journalEntryId) : undefined;
      const cur = map.get(id) ?? { paid: ZERO, committed: ZERO };
      if (s === 'posted') cur.paid = cur.paid.plus(r.amount);
      if (s && s !== 'rejected') cur.committed = cur.committed.plus(r.amount);
      map.set(id, cur);
    }
    return map;
  }

  /** Calculated document status (never stored). */
  static documentStatus(total: Decimal, paid: Decimal): 'unpaid' | 'part_paid' | 'paid' {
    if (paid.gte(total)) return 'paid';
    return paid.gt(0) ? 'part_paid' : 'unpaid';
  }

  /** Unpaid client invoices (posted) by age since the issue date: 0-30, 31-60, 61-90, 90+ days. */
  async receivablesAging(date: string): Promise<AgingView> {
    const invoices = await this.prisma.invoice.findMany({
      where: { cancelledAt: null, issueDate: { lte: dbDate(date) }, journalEntryId: { not: null } },
      include: { party: { select: { name: true } } },
      orderBy: { issueDate: 'asc' },
    });
    const entries = await this.postedIds(invoices.map((i) => i.journalEntryId!));
    const posted = invoices.filter((i) => entries.has(i.journalEntryId!));
    const paid = await this.allocationTotals('invoice', posted.map((i) => i.id));
    const buckets: AgingView['buckets'] = [
      { label: '0-30', amount: '0.00', count: 0 },
      { label: '31-60', amount: '0.00', count: 0 },
      { label: '61-90', amount: '0.00', count: 0 },
      { label: '90+', amount: '0.00', count: 0 },
    ];
    const items: AgingView['items'] = [];
    let total = ZERO;
    for (const inv of posted) {
      const open = dec(inv.total).minus(paid.get(inv.id)?.paid ?? ZERO);
      if (open.lte(0)) continue;
      const age = daysFrom(dayOf(inv.issueDate), date);
      const bucket = age <= 30 ? buckets[0] : age <= 60 ? buckets[1] : age <= 90 ? buckets[2] : buckets[3];
      const openBase = open.times(inv.exchangeRate).toDecimalPlaces(2);
      bucket.amount = money(dec(bucket.amount).plus(openBase));
      bucket.count++;
      total = total.plus(openBase);
      items.push({ id: inv.id, number: inv.number, partyId: inv.partyId, partyName: inv.party.name, issueDate: dayOf(inv.issueDate), dueDate: dayOf(inv.dueDate), ageDays: age, bucket: bucket.label, currency: inv.currency, open: money(open), openBase: money(openBase) });
    }
    return { date, buckets, items, total: money(total) };
  }

  /** Vendor bills (posted) with an amount still to pay, earliest due first. */
  async billsToPay(date: string): Promise<BillsDueView> {
    const bills = await this.prisma.bill.findMany({
      where: { cancelledAt: null, journalEntryId: { not: null } },
      include: { party: { select: { name: true } } },
      orderBy: { dueDate: 'asc' },
    });
    const entries = await this.postedIds(bills.map((b) => b.journalEntryId!));
    const posted = bills.filter((b) => entries.has(b.journalEntryId!));
    const paid = await this.allocationTotals('bill', posted.map((b) => b.id));
    const items: BillsDueView['items'] = [];
    let total = ZERO;
    for (const b of posted) {
      const open = dec(b.total).minus(paid.get(b.id)?.paid ?? ZERO);
      if (open.lte(0)) continue;
      const openBase = open.times(b.exchangeRate).toDecimalPlaces(2);
      total = total.plus(openBase);
      items.push({ id: b.id, number: b.number, partyId: b.partyId, partyName: b.party.name, dueDate: dayOf(b.dueDate), overdueDays: Math.max(0, daysFrom(dayOf(b.dueDate), date)), currency: b.currency, open: money(open), openBase: money(openBase) });
    }
    return { date, items, total: money(total) };
  }

  /** Income minus expenses (PKR, posted) by project tag. */
  async profitByProject(from: string, to: string): Promise<ProfitView> {
    const lines = await this.prisma.journalLine.findMany({
      where: { entry: this.postedWhere({ from, to }), account: { group: { in: ['income', 'expense'] } } },
      select: { baseDebit: true, baseCredit: true, account: { select: { group: true } }, entry: { select: { projectId: true, project: { select: { code: true, name: true } } } } },
    });
    return { from, to, rows: this.profitRows(lines.map((l) => ({ key: l.entry.projectId, label: l.entry.project ? `${l.entry.project.code} ${l.entry.project.name}` : 'No project', group: l.account.group, dr: l.baseDebit, cr: l.baseCredit }))) };
  }

  /** Income minus expenses (PKR, posted) by the client tagged on the income / expense line. */
  async profitByClient(from: string, to: string): Promise<ProfitView> {
    const lines = await this.prisma.journalLine.findMany({
      where: { entry: this.postedWhere({ from, to }), account: { group: { in: ['income', 'expense'] } } },
      select: { baseDebit: true, baseCredit: true, partyId: true, party: { select: { name: true, kind: true } }, account: { select: { group: true } } },
    });
    return {
      from,
      to,
      rows: this.profitRows(
        lines.map((l) => {
          const client = l.party?.kind === 'client';
          return { key: client ? l.partyId : null, label: client ? l.party!.name : 'No client', group: l.account.group, dr: l.baseDebit, cr: l.baseCredit };
        }),
      ),
    };
  }

  private profitRows(lines: Array<{ key: string | null; label: string; group: AccountGroup; dr: Decimal; cr: Decimal }>): ProfitView['rows'] {
    const map = new Map<string, { id: string | null; label: string; income: Decimal; expense: Decimal }>();
    for (const l of lines) {
      const k = l.key ?? '';
      const cur = map.get(k) ?? { id: l.key, label: l.label, income: ZERO, expense: ZERO };
      if (l.group === 'income') cur.income = cur.income.plus(dec(l.cr).minus(l.dr));
      else cur.expense = cur.expense.plus(dec(l.dr).minus(l.cr));
      map.set(k, cur);
    }
    return [...map.values()]
      .map((r) => ({ id: r.id, label: r.label, income: money(r.income), expense: money(r.expense), profit: money(r.income.minus(r.expense)) }))
      .sort((a, b) => dec(b.profit).comparedTo(dec(a.profit)));
  }

  private async postedIds(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.journalEntry.findMany({ where: { id: { in: ids }, status: 'posted' }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }
}
