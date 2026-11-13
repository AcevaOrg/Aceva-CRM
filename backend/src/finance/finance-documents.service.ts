import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, PayloadTooLargeException } from '@nestjs/common';
import type { BillView, EntryStatus, InvoiceView, PaymentView, ReceiptView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { withDbRules } from '../common/db-rules';
import { dec, money, round2, sum, ZERO, type Decimal } from '../common/money';
import { dayOf, dbDate } from '../common/pakistan-time';
import type { Currency, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { detectFileType, safeFileName } from '../storage/file-type';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage';
import { badRequest, conflict, notFound } from './finance-errors';
import { receiptView, shownStatus } from './finance-views';
import { JournalService, type LineDraft } from './journal.service';
import { LedgerQueryService } from './ledger-query.service';

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const RECEIPT_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);

export interface UploadedFileData {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/**
 * The company details printed on invoices. DEVELOPMENT DEFAULT: what Aceva prints (legal name, address, tax numbers, bank
 * details) is decision D13 in docs/M7-M9-DECISIONS.md; until then only the name is printed.
 */
export const INVOICE_COMPANY = { name: 'Aceva', note: 'Company details to be confirmed (decision D13).' };

type Tx = Prisma.TransactionClient;

/**
 * Client invoices, vendor bills (with the receipt uploaded), payments received and made, and transfers between bank
 * accounts (plan section 13). Each one creates its ledger entry and submits it: it waits for approval like every entry.
 * Paid / part paid / unpaid is calculated from the allocations of payments whose entries are POSTED, never stored.
 */
@Injectable()
export class FinanceDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly ledger: LedgerQueryService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  // ------------------------------------------------------------------------------------------------ shared helpers

  private async roleAccount(db: Tx | PrismaService, role: string): Promise<string> {
    const a = await db.ledgerAccount.findUnique({ where: { systemRole: role }, select: { id: true, archivedAt: true } });
    if (!a || a.archivedAt) throw conflict('account_role_missing', `No active account has the role "${role}". The accountant maps it in the chart of accounts.`);
    return a.id;
  }

  private async partyOf(db: Tx | PrismaService, id: string, kind: 'client' | 'vendor') {
    const p = await db.party.findUnique({ where: { id } });
    if (!p || p.archivedAt) throw badRequest('unknown_party', `The ${kind} does not exist or is archived`);
    if (p.kind !== kind) throw badRequest('wrong_party_kind', `Choose a ${kind}`);
    return p;
  }

  private async postingAccount(db: Tx | PrismaService, ref: { accountId?: string; accountCode?: string }, groups: string[], what: string) {
    const a = await db.ledgerAccount.findFirst({
      where: ref.accountId ? { id: ref.accountId } : { code: ref.accountCode },
      include: { children: { where: { archivedAt: null }, select: { id: true }, take: 1 } },
    });
    if (!a || a.archivedAt || a.children.length || !groups.includes(a.group) || a.isBank || a.systemRole === 'accounts_receivable' || a.systemRole === 'accounts_payable') {
      throw badRequest('invalid_account', `Choose an active ${what} account`);
    }
    return a;
  }

  private async bankAccount(db: Tx | PrismaService, id: string) {
    const a = await db.ledgerAccount.findUnique({ where: { id } });
    if (!a || !a.isBank || a.archivedAt) throw badRequest('unknown_bank_account', 'Choose an active bank account');
    return a;
  }

  private async entryInfo(ids: Array<string | null>): Promise<Map<string, { number: string; status: EntryStatus }>> {
    const real = ids.filter((x): x is string => !!x);
    if (!real.length) return new Map();
    const rows = await this.prisma.journalEntry.findMany({ where: { id: { in: real } }, select: { id: true, number: true, status: true, reversedBy: { where: { status: { not: 'rejected' } }, take: 1, select: { status: true } } } });
    return new Map(rows.map((r) => [r.id, { number: r.number, status: shownStatus(r.status, r.reversedBy[0]?.status) }]));
  }

  // ------------------------------------------------------------------------------------------------ invoices

  async createInvoice(
    actor: Actor,
    dto: { partyId: string; issueDate: string; dueDate: string; currency: Currency; exchangeRate?: string; projectId?: string; notes?: string; lines: Array<{ description: string; quantity: string; unitPrice: string; accountId?: string; accountCode?: string }> },
    client: RequestInfo,
  ): Promise<InvoiceView> {
    const ctx = { actorId: actor.id, ...client };
    const id = await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const party = await this.partyOf(tx, dto.partyId, 'client');
        const ar = await this.roleAccount(tx, 'accounts_receivable');
        const lines: Array<{ description: string; quantity: Decimal; unitPrice: Decimal; amount: Decimal; accountId: string }> = [];
        for (const l of dto.lines) {
          const account = await this.postingAccount(tx, l, ['income'], 'income');
          const quantity = dec(l.quantity);
          const unitPrice = dec(l.unitPrice);
          lines.push({ description: l.description.trim(), quantity, unitPrice, amount: round2(quantity.times(unitPrice)), accountId: account.id });
        }
        const total = sum(lines.map((l) => l.amount));
        if (total.lte(0)) throw badRequest('invalid_amount', 'The invoice total must be more than zero');
        await this.journal.assertOpen(tx, dto.issueDate);
        const rate = await this.journal.resolveRate(tx, dto.currency, dto.issueDate, dto.exchangeRate ? dec(dto.exchangeRate) : null);
        const invoice = await tx.invoice.create({
          data: {
            partyId: party.id,
            issueDate: dbDate(dto.issueDate),
            dueDate: dbDate(dto.dueDate),
            currency: dto.currency,
            exchangeRate: rate,
            total,
            projectId: dto.projectId ?? null,
            notes: dto.notes ?? null,
            createdBy: actor.id,
            updatedBy: actor.id,
            lines: { create: lines.map((l, i) => ({ lineNo: i + 1, ...l })) },
          },
        });
        const entryLines: LineDraft[] = [
          { accountId: ar, debit: total, credit: ZERO, partyId: party.id, description: `Invoice ${invoice.number}` },
          // Income lines carry the client too, so profit can be reported by client.
          ...lines.filter((l) => l.amount.gt(0)).map((l) => ({ accountId: l.accountId, debit: ZERO, credit: l.amount, partyId: party.id, description: l.description })),
        ];
        const entry = await this.journal.createAndSubmitTx(
          tx,
          { date: dto.issueDate, description: `Invoice ${invoice.number}: ${party.name}`, source: 'invoice', sourceRef: invoice.id, purpose: 'invoice', currency: dto.currency, exchangeRate: rate, projectId: dto.projectId ?? null, makerId: actor.id, lines: entryLines },
          ctx,
        );
        await tx.invoice.update({ where: { id: invoice.id }, data: { journalEntryId: entry.id } });
        await this.audit.record({ actorId: actor.id, action: 'finance.invoice.created', targetType: 'invoice', targetId: invoice.number, details: { entry: entry.number, currency: dto.currency, lines: lines.length }, ...client }, tx);
        return invoice.id;
      }),
    );
    return this.invoice(id);
  }

  async invoices(q: { page: number; pageSize: number; partyId?: string; status?: 'unpaid' | 'part_paid' | 'paid' | 'all' }) {
    const where: Prisma.InvoiceWhereInput = { cancelledAt: null, ...(q.partyId ? { partyId: q.partyId } : {}) };
    // The status is calculated, so a status filter is applied after calculating it.
    const rows = await this.prisma.invoice.findMany({ where, include: { party: { select: { name: true } }, lines: { orderBy: { lineNo: 'asc' } } }, orderBy: [{ issueDate: 'desc' }, { number: 'desc' }] });
    let views = await this.invoiceViews(rows);
    if (q.status && q.status !== 'all') views = views.filter((v) => v.status === q.status);
    return { items: views.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: views.length, page: q.page, pageSize: q.pageSize };
  }

  async invoice(id: string): Promise<InvoiceView> {
    const row = await this.prisma.invoice.findUnique({ where: { id }, include: { party: { select: { name: true } }, lines: { orderBy: { lineNo: 'asc' } } } });
    if (!row) throw notFound('Invoice');
    return (await this.invoiceViews([row]))[0];
  }

  private async invoiceViews(
    rows: Array<Prisma.InvoiceGetPayload<{ include: { party: { select: { name: true } }; lines: true } }>>,
  ): Promise<InvoiceView[]> {
    const [alloc, entries, accounts] = await Promise.all([
      this.ledger.allocationTotals('invoice', rows.map((r) => r.id)),
      this.entryInfo(rows.map((r) => r.journalEntryId)),
      this.prisma.ledgerAccount.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.lines.map((l) => l.accountId)))] } }, select: { id: true, code: true } }),
    ]);
    const code = new Map(accounts.map((a) => [a.id, a.code]));
    return rows.map((r) => {
      const a = alloc.get(r.id) ?? { paid: ZERO, committed: ZERO };
      const e = r.journalEntryId ? entries.get(r.journalEntryId) : undefined;
      return {
        id: r.id,
        number: r.number,
        partyId: r.partyId,
        partyName: r.party.name,
        issueDate: dayOf(r.issueDate),
        dueDate: dayOf(r.dueDate),
        currency: r.currency,
        exchangeRate: dec(r.exchangeRate).toFixed(6),
        total: money(r.total),
        totalBase: money(dec(r.total).times(r.exchangeRate)),
        paid: money(a.paid),
        open: money(dec(r.total).minus(a.committed)),
        status: LedgerQueryService.documentStatus(dec(r.total), a.paid),
        projectId: r.projectId,
        notes: r.notes,
        entryId: r.journalEntryId,
        entryNumber: e?.number ?? null,
        entryStatus: e?.status ?? null,
        lines: r.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: dec(l.quantity).toFixed(2), unitPrice: money(l.unitPrice), amount: money(l.amount), accountId: l.accountId, accountCode: code.get(l.accountId) ?? '' })),
      };
    });
  }

  /** A printable HTML invoice (no PDF library is approved yet: decision D15). Values are escaped. */
  async invoiceDocument(actor: Actor, id: string, client: RequestInfo): Promise<string> {
    const inv = await this.invoice(id);
    const party = await this.prisma.party.findUniqueOrThrow({ where: { id: inv.partyId } });
    await this.audit.record({ actorId: actor.id, action: 'finance.invoice.document_viewed', targetType: 'invoice', targetId: inv.number, ...client });
    const esc = (s: string | null | undefined) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    const statusLabel = { unpaid: 'Unpaid', part_paid: 'Part paid', paid: 'Paid' }[inv.status];
    const rows = inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="n">${esc(l.quantity)}</td><td class="n">${esc(l.unitPrice)}</td><td class="n">${esc(l.amount)}</td></tr>`).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice ${esc(inv.number)}</title>
<style>body{font-family:system-ui,sans-serif;margin:40px;color:#111}h1{margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:24px}
th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left}.n{text-align:right}.muted{color:#666;font-size:12px}.tot td{font-weight:700}</style></head>
<body>
<header><h1>${esc(INVOICE_COMPANY.name)}</h1><div class="muted">${esc(INVOICE_COMPANY.note)}</div></header>
<h2>Invoice ${esc(inv.number)}</h2>
<p><strong>Bill to:</strong> ${esc(party.name)}${party.address ? `<br>${esc(party.address)}` : ''}${party.email ? `<br>${esc(party.email)}` : ''}</p>
<p>Issue date: ${esc(inv.issueDate)} &middot; Due date: ${esc(inv.dueDate)} &middot; Currency: ${esc(inv.currency)} &middot; Status: ${esc(statusLabel)}</p>
<table><thead><tr><th>Description</th><th class="n">Quantity</th><th class="n">Unit price</th><th class="n">Amount</th></tr></thead>
<tbody>${rows}<tr class="tot"><td colspan="3">Total (${esc(inv.currency)})</td><td class="n">${esc(inv.total)}</td></tr>
<tr><td colspan="3">Paid</td><td class="n">${esc(inv.paid)}</td></tr></tbody></table>
${inv.notes ? `<p>${esc(inv.notes)}</p>` : ''}
</body></html>`;
  }

  // ------------------------------------------------------------------------------------------------ bills

  async createBill(
    actor: Actor,
    dto: { partyId: string; billDate: string; dueDate: string; currency: Currency; exchangeRate?: string; accountId?: string; accountCode?: string; projectId?: string; description: string; vendorRef?: string; total: string },
    client: RequestInfo,
  ): Promise<BillView> {
    const ctx = { actorId: actor.id, ...client };
    const id = await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const party = await this.partyOf(tx, dto.partyId, 'vendor');
        const ap = await this.roleAccount(tx, 'accounts_payable');
        const account = await this.postingAccount(tx, dto, ['expense', 'asset'], 'expense');
        await this.journal.assertOpen(tx, dto.billDate);
        const rate = await this.journal.resolveRate(tx, dto.currency, dto.billDate, dto.exchangeRate ? dec(dto.exchangeRate) : null);
        const total = dec(dto.total);
        const bill = await tx.bill.create({
          data: {
            partyId: party.id,
            vendorRef: dto.vendorRef ?? null,
            billDate: dbDate(dto.billDate),
            dueDate: dbDate(dto.dueDate),
            currency: dto.currency,
            exchangeRate: rate,
            total,
            accountId: account.id,
            projectId: dto.projectId ?? null,
            description: dto.description.trim(),
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        const entry = await this.journal.createAndSubmitTx(
          tx,
          {
            date: dto.billDate,
            description: `Bill ${bill.number}: ${party.name}, ${dto.description.trim()}`.slice(0, 300),
            source: 'bill',
            sourceRef: bill.id,
            purpose: 'bill',
            currency: dto.currency,
            exchangeRate: rate,
            projectId: dto.projectId ?? null,
            makerId: actor.id,
            lines: [
              { accountId: account.id, debit: total, credit: ZERO, partyId: party.id, description: dto.description.trim() },
              { accountId: ap, debit: ZERO, credit: total, partyId: party.id, description: `Bill ${bill.number}` },
            ],
          },
          ctx,
        );
        await tx.bill.update({ where: { id: bill.id }, data: { journalEntryId: entry.id } });
        await this.audit.record({ actorId: actor.id, action: 'finance.bill.created', targetType: 'bill', targetId: bill.number, details: { entry: entry.number, currency: dto.currency }, ...client }, tx);
        return bill.id;
      }),
    );
    return this.bill(id);
  }

  async bills(q: { page: number; pageSize: number; partyId?: string; status?: 'unpaid' | 'part_paid' | 'paid' | 'all' }) {
    const rows = await this.prisma.bill.findMany({
      where: { cancelledAt: null, ...(q.partyId ? { partyId: q.partyId } : {}) },
      include: { party: { select: { name: true } }, receipts: { where: { archivedAt: null } } },
      orderBy: [{ billDate: 'desc' }, { number: 'desc' }],
    });
    let views = await this.billViews(rows);
    if (q.status && q.status !== 'all') views = views.filter((v) => v.status === q.status);
    return { items: views.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: views.length, page: q.page, pageSize: q.pageSize };
  }

  async bill(id: string): Promise<BillView> {
    const row = await this.prisma.bill.findUnique({ where: { id }, include: { party: { select: { name: true } }, receipts: { where: { archivedAt: null } } } });
    if (!row) throw notFound('Bill');
    return (await this.billViews([row]))[0];
  }

  private async billViews(rows: Array<Prisma.BillGetPayload<{ include: { party: { select: { name: true } }; receipts: true } }>>): Promise<BillView[]> {
    const [alloc, entries, accounts] = await Promise.all([
      this.ledger.allocationTotals('bill', rows.map((r) => r.id)),
      this.entryInfo(rows.map((r) => r.journalEntryId)),
      this.prisma.ledgerAccount.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.accountId))] } }, select: { id: true, code: true } }),
    ]);
    const code = new Map(accounts.map((a) => [a.id, a.code]));
    return rows.map((r) => {
      const a = alloc.get(r.id) ?? { paid: ZERO, committed: ZERO };
      const e = r.journalEntryId ? entries.get(r.journalEntryId) : undefined;
      return {
        id: r.id,
        number: r.number,
        partyId: r.partyId,
        partyName: r.party.name,
        vendorRef: r.vendorRef,
        billDate: dayOf(r.billDate),
        dueDate: dayOf(r.dueDate),
        currency: r.currency,
        exchangeRate: dec(r.exchangeRate).toFixed(6),
        total: money(r.total),
        totalBase: money(dec(r.total).times(r.exchangeRate)),
        paid: money(a.paid),
        open: money(dec(r.total).minus(a.committed)),
        status: LedgerQueryService.documentStatus(dec(r.total), a.paid),
        accountId: r.accountId,
        accountCode: code.get(r.accountId) ?? '',
        projectId: r.projectId,
        description: r.description,
        entryId: r.journalEntryId,
        entryNumber: e?.number ?? null,
        entryStatus: e?.status ?? null,
        receipts: r.receipts.map(receiptView),
      };
    });
  }

  // ------------------------------------------------------------------------------------------------ receipts (private storage)

  /** A receipt for a bill or an entry: PDF, PNG or JPEG by its real content, at most 10 MB, kept in private storage. */
  async uploadReceipt(actor: Actor, target: { billId?: string; entryId?: string }, file: UploadedFileData | undefined, client: RequestInfo): Promise<ReceiptView> {
    let entryId: string | null = target.entryId ?? null;
    let label = '';
    if (target.billId) {
      const bill = await this.prisma.bill.findUnique({ where: { id: target.billId } });
      if (!bill) throw notFound('Bill');
      entryId = bill.journalEntryId;
      label = bill.number;
    } else if (target.entryId) {
      const entry = await this.prisma.journalEntry.findUnique({ where: { id: target.entryId } });
      if (!entry) throw notFound('Entry');
      label = entry.number;
    }
    if (!file || file.size === 0) throw badRequest('no_file', 'Choose a file to upload');
    if (file.size > MAX_RECEIPT_BYTES) throw new PayloadTooLargeException({ statusCode: 413, code: 'file_too_large', message: 'The file is too large (limit 10 MB)' });
    const detected = detectFileType(file.buffer);
    if (!detected || !RECEIPT_TYPES.has(detected.mime)) throw badRequest('file_type_not_allowed', 'A receipt must be a PDF, PNG or JPEG file');
    const key = `finance/receipts/${target.billId ?? target.entryId}/${randomUUID()}${detected.ext}`; // generated, never the uploaded name
    await this.storage.put(key, file.buffer);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const r = await tx.receipt.create({
          data: {
            billId: target.billId ?? null,
            entryId,
            storageKey: key,
            originalFilename: safeFileName(file.originalname),
            mimeType: detected.mime,
            sizeBytes: file.size,
            sha256: createHash('sha256').update(file.buffer).digest('hex'),
            createdBy: actor.id,
          },
        });
        await this.audit.record({ actorId: actor.id, action: 'finance.receipt.uploaded', targetType: target.billId ? 'bill' : 'journal_entry', targetId: label, details: { receiptId: r.id, mimeType: detected.mime, sizeBytes: file.size }, ...client }, tx);
        return r;
      });
      return receiptView(row);
    } catch (error) {
      await this.storage.remove(key);
      throw error;
    }
  }

  async downloadReceipt(actor: Actor, id: string, client: RequestInfo): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const r = await this.prisma.receipt.findFirst({ where: { id, archivedAt: null } });
    if (!r) throw notFound('Receipt');
    const buffer = await this.storage.get(r.storageKey);
    await this.audit.record({ actorId: actor.id, action: 'finance.receipt.downloaded', targetType: 'receipt', targetId: r.id, ...client });
    return { buffer, mimeType: r.mimeType, fileName: r.originalFilename };
  }

  // ------------------------------------------------------------------------------------------------ payments

  async createPayment(
    actor: Actor,
    dto: { direction: 'received' | 'made'; partyId: string; bankAccountId: string; paymentDate: string; amount: string; exchangeRate?: string; method?: string; reference?: string; projectId?: string; allocations: Array<{ invoiceId?: string; billId?: string; amount: string }> },
    client: RequestInfo,
  ): Promise<PaymentView> {
    const ctx = { actorId: actor.id, ...client };
    const id = await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const received = dto.direction === 'received';
        const party = await this.partyOf(tx, dto.partyId, received ? 'client' : 'vendor');
        const bank = await this.bankAccount(tx, dto.bankAccountId);
        const control = await this.roleAccount(tx, received ? 'accounts_receivable' : 'accounts_payable');
        const amount = dec(dto.amount);
        const currency = bank.currency;

        // Allocations: documents of this party, in the payment currency, never more than what is still open.
        const perDoc = new Map<string, Decimal>();
        for (const a of dto.allocations) {
          const docId = received ? a.invoiceId : a.billId;
          if (!docId) throw badRequest('wrong_document', received ? 'A payment received is allocated to invoices' : 'A payment made is allocated to bills');
          perDoc.set(docId, (perDoc.get(docId) ?? ZERO).plus(dec(a.amount)));
        }
        const allocated = sum(perDoc.values());
        if (allocated.gt(amount)) throw badRequest('overpayment', `The allocations (${money(allocated)}) are more than the payment (${money(amount)})`);
        const docIds = [...perDoc.keys()];
        if (docIds.length) {
          // Lock the documents so two payments cannot allocate the same open amount at the same time.
          if (received) await tx.$queryRaw`SELECT id FROM invoices WHERE id = ANY(${docIds}::uuid[]) FOR UPDATE`;
          else await tx.$queryRaw`SELECT id FROM bills WHERE id = ANY(${docIds}::uuid[]) FOR UPDATE`;
          const docs = received
            ? await tx.invoice.findMany({ where: { id: { in: docIds } }, select: { id: true, number: true, partyId: true, currency: true, total: true, cancelledAt: true, journalEntryId: true } })
            : await tx.bill.findMany({ where: { id: { in: docIds } }, select: { id: true, number: true, partyId: true, currency: true, total: true, cancelledAt: true, journalEntryId: true } });
          if (docs.length !== docIds.length) throw badRequest('wrong_document', 'A document in the allocations does not exist');
          const statuses = await tx.journalEntry.findMany({ where: { id: { in: docs.map((d) => d.journalEntryId!).filter(Boolean) } }, select: { id: true, status: true } });
          const totals = await this.ledger.allocationTotals(received ? 'invoice' : 'bill', docIds, tx);
          for (const d of docs) {
            if (d.partyId !== party.id) throw badRequest('wrong_party', `${d.number} belongs to another ${received ? 'client' : 'vendor'}`);
            const st = statuses.find((s) => s.id === d.journalEntryId)?.status;
            if (d.cancelledAt || !st || st === 'rejected') throw badRequest('wrong_document', `${d.number} cannot take payments (its entry was rejected)`);
            if (d.currency !== currency) throw badRequest('currency_mismatch', `${d.number} is in ${d.currency}; pay it from a ${d.currency} bank account`);
            const open = dec(d.total).minus(totals.get(d.id)?.committed ?? ZERO);
            if (perDoc.get(d.id)!.gt(open)) throw badRequest('overpayment', `${d.number} has only ${money(open)} ${d.currency} still open`);
          }
        }

        await this.journal.assertOpen(tx, dto.paymentDate);
        const rate = await this.journal.resolveRate(tx, currency, dto.paymentDate, dto.exchangeRate ? dec(dto.exchangeRate) : null);
        const payment = await tx.payment.create({
          data: {
            direction: dto.direction,
            partyId: party.id,
            bankAccountId: bank.id,
            paymentDate: dbDate(dto.paymentDate),
            currency,
            exchangeRate: rate,
            amount,
            method: dto.method ?? null,
            reference: dto.reference ?? null,
            createdBy: actor.id,
            allocations: { create: [...perDoc.entries()].map(([docId, a]) => (received ? { invoiceId: docId, amount: a } : { billId: docId, amount: a })) },
          },
        });
        const label = `${received ? 'Payment received from' : 'Payment to'} ${party.name}${dto.reference ? ` (${dto.reference})` : ''}`;
        const entry = await this.journal.createAndSubmitTx(
          tx,
          {
            date: dto.paymentDate,
            description: label.slice(0, 300),
            source: 'payment',
            sourceRef: payment.id,
            purpose: 'payment',
            currency,
            exchangeRate: rate,
            projectId: dto.projectId ?? null,
            makerId: actor.id,
            lines: received
              ? [
                  { accountId: bank.id, debit: amount, credit: ZERO, description: label },
                  { accountId: control, debit: ZERO, credit: amount, partyId: party.id, description: label },
                ]
              : [
                  { accountId: control, debit: amount, credit: ZERO, partyId: party.id, description: label },
                  { accountId: bank.id, debit: ZERO, credit: amount, description: label },
                ],
          },
          ctx,
        );
        await tx.payment.update({ where: { id: payment.id }, data: { journalEntryId: entry.id } });
        await this.audit.record({ actorId: actor.id, action: `finance.payment.${dto.direction}`, targetType: 'payment', targetId: payment.id, details: { entry: entry.number, allocations: perDoc.size, currency }, ...client }, tx);
        return payment.id;
      }),
    );
    return this.payment(id);
  }

  async payments(q: { page: number; pageSize: number; partyId?: string; direction?: 'received' | 'made' }) {
    const where: Prisma.PaymentWhereInput = { ...(q.partyId ? { partyId: q.partyId } : {}), ...(q.direction ? { direction: q.direction } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({ where, orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
    ]);
    const items = await Promise.all(rows.map((r) => this.payment(r.id)));
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async payment(id: string): Promise<PaymentView> {
    const p = await this.prisma.payment.findUnique({
      where: { id },
      include: { party: { select: { name: true } }, allocations: { include: { invoice: { select: { number: true } }, bill: { select: { number: true } } } } },
    });
    if (!p) throw notFound('Payment');
    const bank = await this.prisma.ledgerAccount.findUnique({ where: { id: p.bankAccountId }, select: { name: true } });
    const e = (await this.entryInfo([p.journalEntryId])).get(p.journalEntryId ?? '');
    return {
      id: p.id,
      direction: p.direction,
      partyId: p.partyId,
      partyName: p.party.name,
      bankAccountId: p.bankAccountId,
      bankAccountName: bank?.name ?? '',
      paymentDate: dayOf(p.paymentDate),
      currency: p.currency,
      exchangeRate: dec(p.exchangeRate).toFixed(6),
      amount: money(p.amount),
      method: p.method,
      reference: p.reference,
      entryId: p.journalEntryId,
      entryNumber: e?.number ?? null,
      entryStatus: e?.status ?? null,
      allocations: p.allocations.map((a) => ({ invoiceId: a.invoiceId, billId: a.billId, documentNumber: a.invoice?.number ?? a.bill?.number ?? '', amount: money(a.amount) })),
    };
  }

  // ------------------------------------------------------------------------------------------------ transfers

  /**
   * Money moved between two bank accounts. Same currency: one entry in that currency (Dr to / Cr from). Different currencies
   * (PKR <-> USD): the USD amount and the PKR amount are both given; the entry is in USD at the effective rate, and both lines
   * carry the exact PKR amount, so the PKR account moves by exactly what left or arrived.
   */
  async createTransfer(actor: Actor, dto: { fromAccountId: string; toAccountId: string; date: string; amount: string; toAmount?: string; exchangeRate?: string; description?: string }, client: RequestInfo) {
    const ctx = { actorId: actor.id, ...client };
    const id = await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const from = await this.bankAccount(tx, dto.fromAccountId);
        const to = await this.bankAccount(tx, dto.toAccountId);
        const amount = dec(dto.amount);
        const description = (dto.description?.trim() || `Transfer from ${from.code} to ${to.code}`).slice(0, 300);
        let lines: LineDraft[];
        let currency: Currency;
        let rate: Decimal | null;
        if (from.currency === to.currency) {
          if (dto.toAmount && !dec(dto.toAmount).equals(amount)) throw badRequest('invalid_amount', 'Both accounts are in the same currency: the amount that arrives is the amount sent');
          currency = from.currency;
          rate = dto.exchangeRate ? dec(dto.exchangeRate) : null;
          lines = [
            { accountId: to.id, debit: amount, credit: ZERO, description },
            { accountId: from.id, debit: ZERO, credit: amount, description },
          ];
        } else {
          if (!dto.toAmount) throw badRequest('to_amount_required', `Enter the amount that arrived in ${to.currency}`);
          const usd = from.currency === 'USD' ? amount : dec(dto.toAmount);
          const pkr = from.currency === 'USD' ? dec(dto.toAmount) : amount;
          currency = 'USD';
          rate = pkr.div(usd).toDecimalPlaces(6);
          lines = [
            { accountId: to.id, debit: usd, credit: ZERO, baseDebit: pkr, description },
            { accountId: from.id, debit: ZERO, credit: usd, baseCredit: pkr, description },
          ];
        }
        const entry = await this.journal.createAndSubmitTx(tx, { date: dto.date, description, source: 'transfer', currency, exchangeRate: rate, makerId: actor.id, lines }, ctx);
        await this.audit.record({ actorId: actor.id, action: 'finance.transfer.created', targetType: 'journal_entry', targetId: entry.number, details: { from: from.code, to: to.code }, ...client }, tx);
        return entry.id;
      }),
    );
    return this.journal.view(actor, id);
  }
}
