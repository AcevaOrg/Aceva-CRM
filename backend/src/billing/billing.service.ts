import { Injectable } from '@nestjs/common';
import type {
  BillingCustomerInput,
  BillingCustomerView,
  BillingInvoiceDetailView,
  BillingInvoiceStatus,
  BillingInvoiceView,
  BillingOverviewView,
  BillingPaymentView,
  BillingReminderView,
  BillingSettings,
  CreateBillingInvoice,
  DealHandoverView,
  EntryStatus,
  IssueInvoice,
  RecordInvoicePayment,
  RecurringRuleView,
  UpdateBillingInvoice,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { StepUpService } from '../auth/step-up.service';
import { Clock } from '../common/clock';
import { isUniqueViolation, withDbRules } from '../common/db-rules';
import { dec, money, round2, sum, ZERO, type Decimal } from '../common/money';
import { addDays, dayOf, dbDate, monthOf, pkDate } from '../common/pakistan-time';
import { OutboxService } from '../events/outbox.service';
import { badRequest, conflict, notFound } from '../finance/finance-errors';
import { csvCell } from '../finance/finance-export.service';
import { FinanceDocumentsService } from '../finance/finance-documents.service';
import { shownStatus } from '../finance/finance-views';
import { InvoiceLifecycleService, type InvoiceLineInput } from '../finance/invoice-lifecycle.service';
import { LedgerQueryService } from '../finance/ledger-query.service';
import { MasterDataService } from '../finance/master-data.service';
import type { BillingPeriod, Prisma } from '../generated/prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleSettingsService } from '../settings/module-settings.service';
import { addMonths, nextPeriodStart, periodAfter } from './billing-dates';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

export const BILLING_SETTINGS = 'billing';
/** At most this many recurring periods are created for one rule in one run (a server that was down catches up slowly). */
const MAX_PERIODS_PER_RUN = 12;

const invoiceInclude = { party: { select: { name: true } }, lines: { orderBy: { lineNo: 'asc' } }, recurringRule: { select: { period: true } } } as const satisfies Prisma.InvoiceInclude;
type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

export interface WonDealPayload {
  dealNumber: string;
  ownerEmpId: string;
  confirmedByEmpId?: string;
  client: { partyId: string | null; name: string; email: string | null; country: string | null };
  service: string;
  value: string;
  currency: 'PKR' | 'USD';
}

/**
 * Module 13: customer billing (plan section 18). Owner: Developer A.
 * Every invoice, line, payment and ledger entry is written by Module 9 (InvoiceLifecycleService, FinanceDocumentsService);
 * this service adds the billing life cycle around them: drafts and their editing, recurring and rental rules, reminders,
 * customer emails, the billing overview, customers' billing details, and the draft made from a Won deal (Module 15).
 * Statuses are calculated: paid and part paid from POSTED payments, overdue from the due date.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: InvoiceLifecycleService,
    private readonly docs: FinanceDocumentsService,
    private readonly ledger: LedgerQueryService,
    private readonly masterData: MasterDataService,
    private readonly settings: ModuleSettingsService,
    private readonly notifications: NotificationService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly stepUp: StepUpService,
    private readonly clock: Clock,
  ) {}

  today(): string {
    return pkDate(this.clock.now());
  }

  settingsValue(db: Db = this.prisma): Promise<BillingSettings> {
    return this.settings.value<BillingSettings>(BILLING_SETTINGS, db);
  }

  // ------------------------------------------------------------------------------------------------ helpers

  private async employeeId(db: Db, empId: string): Promise<string> {
    const e = await db.employee.findUnique({ where: { empId }, select: { id: true, status: true } });
    if (!e || e.status === 'left') throw badRequest('unknown_employee', `Employee ${empId} does not exist or has left`);
    return e.id;
  }

  private async empIds(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
    const real = [...new Set(ids.filter((x): x is string => !!x))];
    if (!real.length) return new Map();
    const rows = await this.prisma.employee.findMany({ where: { id: { in: real } }, select: { id: true, empId: true } });
    return new Map(rows.map((r) => [r.id, r.empId]));
  }

  /** Lines with their income account: the one given, or the default income account of the billing settings. */
  private async resolveLines(db: Db, lines: Array<{ description: string; quantity: string; unitPrice: string; accountId?: string }>, s: BillingSettings): Promise<InvoiceLineInput[]> {
    let fallback: string | null = null;
    const out: InvoiceLineInput[] = [];
    for (const l of lines) {
      let accountId = l.accountId;
      if (!accountId) {
        if (!fallback) {
          const code = s.defaultIncomeAccountCode;
          const a = code ? await db.ledgerAccount.findUnique({ where: { code }, select: { id: true, archivedAt: true } }) : null;
          if (!a || a.archivedAt) throw conflict('income_account_missing', 'Choose the income account of each line, or set the default income account in the billing settings.');
          fallback = a.id;
        }
        accountId = fallback;
      }
      out.push({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, accountId });
    }
    return out;
  }

  private async entryInfo(db: Db, ids: Array<string | null>): Promise<Map<string, { number: string; status: EntryStatus }>> {
    const real = ids.filter((x): x is string => !!x);
    if (!real.length) return new Map();
    const rows = await db.journalEntry.findMany({ where: { id: { in: real } }, select: { id: true, number: true, status: true, reversedBy: { where: { status: { not: 'rejected' } }, take: 1, select: { status: true } } } });
    return new Map(rows.map((r) => [r.id, { number: r.number, status: shownStatus(r.status, r.reversedBy[0]?.status) }]));
  }

  /** Calculated status. Draft and cancelled are life-cycle states; the rest comes from posted payments and the due date. */
  static statusOf(inv: { status: string; total: Decimal; dueDate: string }, paid: Decimal, today: string): BillingInvoiceStatus {
    if (inv.status === 'draft' || inv.status === 'cancelled') return inv.status;
    if (paid.gte(inv.total)) return 'paid';
    if (inv.dueDate < today) return 'overdue';
    return paid.gt(0) ? 'part_paid' : 'issued';
  }

  async views(rows: InvoiceRow[], db: Db = this.prisma): Promise<BillingInvoiceView[]> {
    const today = this.today();
    const [alloc, entries, emp, accounts] = await Promise.all([
      this.ledger.allocationTotals('invoice', rows.map((r) => r.id), db),
      this.entryInfo(db, rows.flatMap((r) => [r.journalEntryId, r.cancelEntryId])),
      this.empIds(rows.flatMap((r) => [r.assignedToId, r.createdBy, r.issuedBy, r.sourceDealOwnerId])),
      db.ledgerAccount.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.lines.map((l) => l.accountId)))] } }, select: { id: true, code: true } }),
    ]);
    const code = new Map(accounts.map((a) => [a.id, a.code]));
    return rows.map((r) => {
      const a = alloc.get(r.id) ?? { paid: ZERO, committed: ZERO };
      const e = r.journalEntryId ? entries.get(r.journalEntryId) : undefined;
      const c = r.cancelEntryId ? entries.get(r.cancelEntryId) : undefined;
      const total = dec(r.total);
      return {
        id: r.id,
        number: r.number,
        partyId: r.partyId,
        partyName: r.party.name,
        kind: r.kind,
        period: r.recurringRule?.period ?? null,
        periodStart: r.periodStart ? dayOf(r.periodStart) : null,
        periodEnd: r.periodEnd ? dayOf(r.periodEnd) : null,
        recurringRuleId: r.recurringRuleId,
        issueDate: dayOf(r.issueDate),
        dueDate: dayOf(r.dueDate),
        termsDays: r.termsDays,
        currency: r.currency,
        exchangeRate: dec(r.exchangeRate).toFixed(6),
        total: money(total),
        paid: money(a.paid),
        pendingPayments: money(a.committed.minus(a.paid)),
        balance: money(total.minus(a.paid)),
        status: BillingService.statusOf({ status: r.status, total, dueDate: dayOf(r.dueDate) }, a.paid, today),
        reminderOffsets: r.reminderOffsets,
        assignedToEmpId: r.assignedToId ? (emp.get(r.assignedToId) ?? null) : null,
        createdByEmpId: r.createdBy ? (emp.get(r.createdBy) ?? null) : null,
        createdAt: r.createdAt.toISOString(),
        issuedAt: r.issuedAt?.toISOString() ?? null,
        issuedByEmpId: r.issuedBy ? (emp.get(r.issuedBy) ?? null) : null,
        emailedAt: r.emailedAt?.toISOString() ?? null,
        cancelledAt: r.cancelledAt?.toISOString() ?? null,
        cancelReason: r.cancelReason,
        entryId: r.journalEntryId,
        entryNumber: e?.number ?? null,
        entryStatus: e?.status ?? null,
        cancelEntryNumber: c?.number ?? null,
        cancelEntryStatus: c?.status ?? null,
        sourceDealNumber: r.sourceDealNumber,
        sourceDealOwnerEmpId: r.sourceDealOwnerId ? (emp.get(r.sourceDealOwnerId) ?? null) : null,
        projectId: r.projectId,
        notes: r.notes,
        lines: r.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: dec(l.quantity).toFixed(2), unitPrice: money(l.unitPrice), amount: money(l.amount), accountId: l.accountId, accountCode: code.get(l.accountId) ?? '' })),
      };
    });
  }

  // ------------------------------------------------------------------------------------------------ invoices: reads

  async invoices(q: { page: number; pageSize: number; partyId?: string; status?: BillingInvoiceStatus | 'all' }) {
    const rows = await this.prisma.invoice.findMany({
      where: q.partyId ? { partyId: q.partyId } : {},
      include: invoiceInclude,
      orderBy: [{ createdAt: 'desc' }],
    });
    let views = await this.views(rows);
    if (q.status && q.status !== 'all') views = views.filter((v) => v.status === q.status);
    return { items: views.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: views.length, page: q.page, pageSize: q.pageSize };
  }

  async invoiceDetail(id: string): Promise<BillingInvoiceDetailView> {
    const row = await this.prisma.invoice.findUnique({ where: { id }, include: invoiceInclude });
    if (!row) throw notFound('Invoice');
    const [invoice] = await this.views([row]);
    const [customer] = await this.customerViews([row.partyId]);
    const [payments, reminders, emails, rule] = await Promise.all([
      this.paymentViews({ invoiceId: id }),
      this.prisma.invoiceReminder.findMany({ where: { invoiceId: id }, orderBy: [{ scheduledFor: 'asc' }, { audience: 'asc' }] }),
      this.prisma.billingCustomerEmail.findMany({ where: { invoiceId: id }, orderBy: { createdAt: 'asc' } }),
      row.recurringRuleId ? this.recurringRules(row.recurringRuleId) : Promise.resolve([]),
    ]);
    return {
      invoice,
      customer,
      payments,
      reminders: reminders.map(
        (r): BillingReminderView => ({ id: r.id, offsetDays: r.offsetDays, audience: r.audience, scheduledFor: dayOf(r.scheduledFor), status: r.status, reason: r.reason, sentAt: r.sentAt?.toISOString() ?? null }),
      ),
      emails: emails.map((m) => ({ id: m.id, kind: m.kind as 'invoice' | 'reminder', reminderOffset: m.reminderOffset, status: m.status, note: m.note, sentAt: m.sentAt?.toISOString() ?? null, createdAt: m.createdAt.toISOString() })),
      recurringRule: rule[0] ?? null,
    };
  }

  // ------------------------------------------------------------------------------------------------ invoices: changes

  /** A draft invoice (no ledger entry). Recurring and rental invoices also create the rule that makes the next ones. */
  async createInvoice(actor: Actor, dto: CreateBillingInvoice, client: RequestInfo): Promise<BillingInvoiceDetailView> {
    const earlier = () => this.prisma.invoice.findUnique({ where: { requestKey: dto.requestKey }, select: { id: true } });
    const existing = await earlier();
    if (existing) return this.invoiceDetail(existing.id);
    let id: string;
    try {
      id = await withDbRules(() =>
        this.prisma.$transaction(async (tx) => {
          const s = await this.settingsValue(tx);
          const lines = await this.resolveLines(tx, dto.lines, s);
          const offsets = dto.reminderOffsets ?? s.reminderOffsets;
          const assignedToId = dto.assignedToEmpId ? await this.employeeId(tx, dto.assignedToEmpId) : actor.id;
          let ruleId: string | null = null;
          let periodStart: string | null = null;
          let periodEnd: string | null = null;
          if (dto.kind !== 'one_time') {
            const period = dto.period as BillingPeriod;
            periodStart = dto.periodStart ?? dto.issueDate;
            const next = nextPeriodStart(periodStart, period);
            periodEnd = addDays(next, -1);
            if (dto.periodEnd && dto.periodEnd < periodEnd) periodEnd = dto.periodEnd;
            const rule = await tx.recurringBillingRule.create({
              data: {
                partyId: dto.partyId,
                kind: dto.kind,
                period,
                currency: dto.currency,
                lines: lines as unknown as Prisma.InputJsonValue,
                termsDays: dto.termsDays,
                reminderOffsets: offsets,
                assignedToId,
                notes: dto.notes?.trim() || null,
                startDate: dbDate(periodStart),
                endDate: dto.periodEnd ? dbDate(dto.periodEnd) : null,
                nextPeriodStart: dbDate(next),
                status: dto.periodEnd && next > dto.periodEnd ? 'ended' : 'active',
                createdBy: actor.id,
                updatedBy: actor.id,
              },
            });
            ruleId = rule.id;
            await this.audit.record({ actorId: actor.id, action: 'billing.recurring.created', targetType: 'recurring_billing_rule', targetId: rule.id, details: { kind: dto.kind, period, from: periodStart, to: dto.periodEnd ?? null }, ...client }, tx);
          }
          const draft = await this.lifecycle.createDraftTx(
            tx,
            actor.id,
            {
              partyId: dto.partyId,
              kind: dto.kind,
              issueDate: dto.issueDate,
              termsDays: dto.termsDays,
              currency: dto.currency,
              projectId: dto.projectId ?? null,
              notes: dto.notes ?? null,
              lines,
              periodStart,
              periodEnd,
              recurringRuleId: ruleId,
              reminderOffsets: offsets,
              assignedToId,
              requestKey: dto.requestKey,
            },
            client,
          );
          return draft.id;
        }),
      );
    } catch (error) {
      const won = isUniqueViolation(error) ? await earlier() : null;
      if (!won) throw error;
      id = won.id;
    }
    return this.invoiceDetail(id);
  }

  async updateInvoice(actor: Actor, id: string, dto: UpdateBillingInvoice, client: RequestInfo): Promise<BillingInvoiceDetailView> {
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const s = await this.settingsValue(tx);
        const current = await tx.invoice.findUnique({ where: { id }, select: { reminderOffsets: true } });
        if (!current) throw notFound('Invoice');
        await this.lifecycle.updateDraftTx(
          tx,
          actor.id,
          id,
          {
            partyId: dto.partyId,
            issueDate: dto.issueDate,
            termsDays: dto.termsDays,
            currency: dto.currency,
            projectId: dto.projectId ?? null,
            notes: dto.notes ?? null,
            lines: await this.resolveLines(tx, dto.lines, s),
            periodStart: dto.periodStart ?? null,
            reminderOffsets: dto.reminderOffsets ?? current.reminderOffsets,
            assignedToId: dto.assignedToEmpId ? await this.employeeId(tx, dto.assignedToEmpId) : null,
          },
          client,
        );
      }),
    );
    return this.invoiceDetail(id);
  }

  /**
   * Issues a draft: Module 9 gives it its number and creates its ledger entry, which waits for approval. Reminders are
   * scheduled. The client is NOT emailed here: the invoice email is queued only once the ledger entry is approved (the
   * billing reader of ledger.entry.posted; review decision 1). A client created from a Won deal must be reviewed first.
   */
  async issueInvoice(actor: Actor, id: string, dto: IssueInvoice, client: RequestInfo): Promise<BillingInvoiceDetailView> {
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const target = await tx.invoice.findUnique({ where: { id }, select: { party: { select: { billingProfile: { select: { needsReview: true } } } } } });
        if (target?.party.billingProfile?.needsReview) throw conflict('client_needs_review', 'This client was created automatically from a Won deal. Review and confirm the client before issuing its invoice.');
        const issued = await this.lifecycle.issueTx(tx, actor.id, id, { issueDate: dto.issueDate ?? this.today(), exchangeRate: dto.exchangeRate ?? null }, client);
        const inv = await tx.invoice.findUniqueOrThrow({ where: { id } });
        if (!inv.assignedToId) await tx.invoice.update({ where: { id }, data: { assignedToId: actor.id } });
        await this.scheduleReminders(tx, id, issued.dueDate, inv.reminderOffsets, issued.issueDate);
        await this.outbox.emit({ type: 'billing.invoice.issued', actor: actor.empId, payload: { invoiceNumber: issued.number, dueDate: issued.dueDate, sourceDealNumber: inv.sourceDealNumber } }, tx);
      }),
    );
    return this.invoiceDetail(id);
  }

  /** One reminder row per reminder day and audience. A day already past when the invoice is issued is recorded as skipped. */
  private async scheduleReminders(tx: Tx, invoiceId: string, dueDate: string, offsets: number[], issueDate: string): Promise<void> {
    const rows = offsets.flatMap((offset) =>
      (['customer', 'staff'] as const).map((audience) => {
        const day = addDays(dueDate, offset);
        const late = day < issueDate;
        return { invoiceId, offsetDays: offset, audience, scheduledFor: dbDate(day), status: late ? ('skipped' as const) : ('scheduled' as const), reason: late ? 'The reminder day had passed when the invoice was issued' : null };
      }),
    );
    if (rows.length) await tx.invoiceReminder.createMany({ data: rows, skipDuplicates: true });
  }

  /** Queues the invoice email (unique dedupe key: at most once per invoice). Callers have checked the entry is POSTED. */
  private async queueInvoiceEmail(tx: Tx, invoiceId: string, to: string, actorId: string | null): Promise<boolean> {
    const { count } = await tx.billingCustomerEmail.createMany({
      data: [{ invoiceId, kind: 'invoice', toAddress: to, dedupeKey: `invoice:${invoiceId}`, nextAttemptAt: this.clock.now(), createdBy: actorId }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  /**
   * The ledger entry of an invoice was APPROVED (posted): its email to the client is queued now, once (review decision 1).
   * Called by the billing reader inside the transaction that records the event, so a retried event queues nothing more.
   * Only invoices issued through billing (Module 9's own POST /invoices are not emailed). A pending or rejected entry never
   * gets here: only an approval writes ledger.entry.posted. Returns why nothing was queued, or 'queued'.
   */
  async onInvoiceEntryPosted(tx: Tx, entryId: string, entryNumber: string): Promise<'queued' | 'already_queued' | 'not_billing' | 'not_issued' | 'emails_off' | 'no_client_email'> {
    const inv = await tx.invoice.findUnique({ where: { journalEntryId: entryId }, include: { party: { select: { email: true } } } });
    if (!inv || !inv.issuedAt) return 'not_billing';
    if (inv.status !== 'issued') return 'not_issued';
    const entry = await tx.journalEntry.findUnique({ where: { id: entryId }, select: { status: true } });
    if (entry?.status !== 'posted') return 'not_issued';
    const s = await this.settingsValue(tx);
    if (!s.customerEmails.enabled || !s.customerEmails.fromAddress) return 'emails_off';
    if (!inv.party.email) return 'no_client_email';
    if (!(await this.queueInvoiceEmail(tx, inv.id, inv.party.email, null))) return 'already_queued';
    await this.audit.record({ actorId: null, action: 'billing.invoice.email_queued', targetType: 'invoice', targetId: inv.number, details: { trigger: 'entry_approved', entry: entryNumber } }, tx);
    return 'queued';
  }

  /** Emails an issued invoice by hand, once, after its entry is approved (for example: customer emails were off at approval). */
  async emailInvoice(actor: Actor, id: string, client: RequestInfo): Promise<BillingInvoiceDetailView> {
    await this.prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id }, include: { party: { select: { email: true } } } });
      if (!inv) throw notFound('Invoice');
      if (inv.status !== 'issued') throw conflict('invalid_transition', 'Only an issued invoice can be emailed');
      const entry = inv.journalEntryId ? await tx.journalEntry.findUnique({ where: { id: inv.journalEntryId }, select: { status: true } }) : null;
      if (entry?.status !== 'posted') throw conflict('entry_not_approved', 'The invoice is emailed to the client only after its ledger entry is approved.');
      const s = await this.settingsValue(tx);
      if (!s.customerEmails.enabled || !s.customerEmails.fromAddress) throw conflict('customer_emails_off', 'Customer emails are switched off in the billing settings. Print the invoice and send it yourself, or ask the Director to set up the sending address.');
      if (!inv.party.email) throw conflict('no_client_email', 'The client has no email address');
      if (await tx.billingCustomerEmail.findUnique({ where: { dedupeKey: `invoice:${id}` } })) throw conflict('already_emailed', 'This invoice was already sent to the client');
      await this.queueInvoiceEmail(tx, id, inv.party.email, actor.id);
      await this.audit.record({ actorId: actor.id, action: 'billing.invoice.email_queued', targetType: 'invoice', targetId: inv.number, details: { trigger: 'by_hand' }, ...client }, tx);
    });
    return this.invoiceDetail(id);
  }

  /** Cancelling an issued invoice reverses money, so it asks for the password again (step-up). */
  async cancelInvoice(actor: Actor, id: string, reason: string, sessionId: string | null, client: RequestInfo): Promise<BillingInvoiceDetailView> {
    const inv = await this.prisma.invoice.findUnique({ where: { id }, select: { status: true, number: true } });
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'draft') await this.stepUp.require(actor, sessionId, 'billing.invoice.cancel', { type: 'invoice', id: inv.number }, client);
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lifecycle.cancelTx(tx, actor.id, id, reason, client);
        await this.stopFollowUps(tx, id, 'Invoice cancelled');
      }),
    );
    return this.invoiceDetail(id);
  }

  /** The reminders and emails still waiting for an invoice are not sent (paid or cancelled). */
  async stopFollowUps(tx: Tx, invoiceId: string, reason: string): Promise<void> {
    await tx.invoiceReminder.updateMany({ where: { invoiceId, status: 'scheduled' }, data: { status: 'skipped', reason } });
    await tx.billingCustomerEmail.updateMany({ where: { invoiceId, status: 'pending' }, data: { status: 'skipped', note: reason } });
  }

  async restoreInvoice(actor: Actor, id: string, client: RequestInfo): Promise<BillingInvoiceDetailView> {
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lifecycle.restoreTx(tx, actor.id, id, client);
        // Reminders still ahead come back; the ones whose day passed meanwhile stay skipped.
        await tx.invoiceReminder.updateMany({ where: { invoiceId: id, status: 'skipped', reason: 'Invoice cancelled', scheduledFor: { gte: dbDate(this.today()) } }, data: { status: 'scheduled', reason: null } });
      }),
    );
    return this.invoiceDetail(id);
  }

  /** A payment for one invoice. It is Module 9's payment: its entry waits for approval; the invoice counts it once posted. */
  async recordPayment(actor: Actor, id: string, dto: RecordInvoicePayment, client: RequestInfo): Promise<BillingInvoiceDetailView> {
    const inv = await this.prisma.invoice.findUnique({ where: { id }, select: { status: true, partyId: true, projectId: true } });
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'issued') throw conflict('invalid_transition', inv.status === 'draft' ? 'Issue the invoice before recording a payment' : 'A cancelled invoice takes no payments');
    await this.docs.createPayment(
      actor,
      {
        direction: 'received',
        partyId: inv.partyId,
        bankAccountId: dto.bankAccountId,
        paymentDate: dto.date,
        amount: dto.amount,
        exchangeRate: dto.exchangeRate,
        method: dto.method,
        reference: dto.reference,
        projectId: inv.projectId ?? undefined,
        allocations: [{ invoiceId: id, amount: dto.amount }],
        requestKey: dto.requestKey,
      },
      client,
    );
    return this.invoiceDetail(id);
  }

  /** A printable invoice with the company details from the billing settings (nothing invented: empty details are left out). */
  async invoiceDocument(actor: Actor, id: string, client: RequestInfo): Promise<string> {
    const { invoice: inv, customer } = await this.invoiceDetail(id);
    const s = await this.settingsValue();
    await this.audit.record({ actorId: actor.id, action: 'billing.invoice.document_viewed', targetType: 'invoice', targetId: inv.number, ...client });
    return renderInvoiceHtml(inv, customer, s);
  }

  /** CSV of invoices (like Module 9's export: finance.export, "confirm again", watermarked and logged). */
  async exportCsv(actor: Actor, sessionId: string | null, client: RequestInfo): Promise<string> {
    await this.stepUp.require(actor, sessionId, 'billing.export', { type: 'invoices' }, client);
    const { items } = await this.invoices({ page: 1, pageSize: 100000 });
    const head = ['Number', 'Client', 'Type', 'Status', 'Issue date', 'Due date', 'Currency', 'Total', 'Paid', 'Balance', 'Entry'];
    const rows = items.map((i) => [i.number, i.partyName, i.kind, i.status, i.issueDate, i.dueDate, i.currency, i.total, i.paid, i.balance, i.entryNumber ?? ''].map(csvCell).join(','));
    await this.audit.record({ actorId: actor.id, action: 'billing.invoices.exported', targetType: 'invoices', targetId: null, details: { rows: rows.length }, ...client });
    return [`Confidential, exported by ${actor.empId} on ${this.clock.now().toISOString()}`, head.join(','), ...rows].join('\r\n') + '\r\n';
  }

  // ------------------------------------------------------------------------------------------------ payments

  async paymentViews(where: { invoiceId?: string; partyId?: string } = {}): Promise<BillingPaymentView[]> {
    const rows = await this.prisma.paymentAllocation.findMany({
      where: { invoiceId: where.invoiceId ?? { not: null }, ...(where.partyId ? { payment: { partyId: where.partyId } } : {}) },
      include: { invoice: { select: { number: true } }, payment: true },
      orderBy: [{ payment: { paymentDate: 'desc' } }, { createdAt: 'desc' }],
    });
    const [entries, banks, emp] = await Promise.all([
      this.entryInfo(this.prisma, rows.map((r) => r.payment.journalEntryId)),
      this.prisma.ledgerAccount.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.payment.bankAccountId))] } }, select: { id: true, name: true } }),
      this.empIds(rows.map((r) => r.payment.createdBy)),
    ]);
    const bank = new Map(banks.map((b) => [b.id, b.name]));
    return rows.map((r) => {
      const e = r.payment.journalEntryId ? entries.get(r.payment.journalEntryId) : undefined;
      return {
        id: r.payment.id,
        invoiceId: r.invoiceId!,
        invoiceNumber: r.invoice?.number ?? '',
        partyId: r.payment.partyId,
        date: dayOf(r.payment.paymentDate),
        currency: r.payment.currency,
        amount: money(r.amount),
        method: r.payment.method,
        reference: r.payment.reference,
        bankAccountName: bank.get(r.payment.bankAccountId) ?? '',
        entryNumber: e?.number ?? null,
        entryStatus: e?.status ?? null,
        recordedByEmpId: r.payment.createdBy ? (emp.get(r.payment.createdBy) ?? null) : null,
        recordedAt: r.payment.createdAt.toISOString(),
      };
    });
  }

  // ------------------------------------------------------------------------------------------------ customers

  async customerViews(partyIds?: string[]): Promise<BillingCustomerView[]> {
    const parties = await this.prisma.party.findMany({
      where: partyIds ? { id: { in: partyIds } } : { kind: 'client', archivedAt: null },
      include: { billingProfile: true },
      orderBy: { name: 'asc' },
    });
    const s = await this.settingsValue();
    const invoices = await this.prisma.invoice.findMany({ where: { partyId: { in: parties.map((p) => p.id) }, status: 'issued' }, select: { id: true, partyId: true, total: true } });
    const alloc = await this.ledger.allocationTotals('invoice', invoices.map((i) => i.id));
    const lastPayments = await this.prisma.payment.groupBy({ by: ['partyId'], where: { direction: 'received', partyId: { in: parties.map((p) => p.id) } }, _max: { paymentDate: true } });
    const last = new Map(lastPayments.map((p) => [p.partyId, p._max.paymentDate]));
    return parties.map((p) => {
      const mine = invoices.filter((i) => i.partyId === p.id);
      const billed = sum(mine.map((i) => dec(i.total)));
      const paid = sum(mine.map((i) => alloc.get(i.id)?.paid ?? ZERO));
      const lp = last.get(p.id);
      return {
        id: p.id,
        name: p.name,
        contactName: p.billingProfile?.contactName ?? null,
        email: p.email,
        phone: p.phone,
        country: p.country,
        address: p.address,
        currency: p.currency,
        termsDays: p.billingProfile?.termsDays ?? s.defaultTermsDays,
        taxId: p.billingProfile?.taxId ?? null,
        notes: p.billingProfile?.notes ?? null,
        totalBilled: money(billed),
        outstanding: money(billed.minus(paid)),
        invoiceCount: mine.length,
        lastPaymentAt: lp ? dayOf(lp) : null,
        needsReview: p.billingProfile?.needsReview ?? false,
        createdFromDeal: p.billingProfile?.createdFromDeal ?? null,
      };
    });
  }

  /** A client is a Module 9 party (kind client) with its billing details beside it. */
  async createCustomer(actor: Actor, dto: BillingCustomerInput, client: RequestInfo): Promise<BillingCustomerView> {
    const s = await this.settingsValue();
    const party = await this.masterData.createParty(actor, { kind: 'client', name: dto.name, email: dto.email, phone: dto.phone, country: dto.country, address: dto.address, currency: dto.currency }, client);
    await this.prisma.$transaction(async (tx) => {
      await tx.billingProfile.create({
        data: { partyId: party.id, contactName: dto.contactName || null, termsDays: dto.termsDays ?? s.defaultTermsDays, taxId: dto.taxId || null, notes: dto.notes || null, createdBy: actor.id, updatedBy: actor.id },
      });
      await this.audit.record({ actorId: actor.id, action: 'billing.customer.created', targetType: 'party', targetId: party.id, details: { name: party.name }, ...client }, tx);
    });
    return (await this.customerViews([party.id]))[0];
  }

  async updateCustomer(actor: Actor, id: string, dto: Partial<BillingCustomerInput>, client: RequestInfo): Promise<BillingCustomerView> {
    const party = await this.prisma.party.findUnique({ where: { id }, include: { billingProfile: true } });
    if (!party || party.kind !== 'client') throw notFound('Client');
    const s = await this.settingsValue();
    const { contactName, termsDays, taxId, notes, ...partyFields } = dto;
    if (Object.keys(partyFields).length) await this.masterData.updateParty(actor, id, partyFields, client);
    if (contactName !== undefined || termsDays !== undefined || taxId !== undefined || notes !== undefined) {
      await this.prisma.$transaction(async (tx) => {
        const data = { contactName: contactName ?? party.billingProfile?.contactName ?? null, termsDays: termsDays ?? party.billingProfile?.termsDays ?? s.defaultTermsDays, taxId: taxId ?? party.billingProfile?.taxId ?? null, notes: notes ?? party.billingProfile?.notes ?? null };
        await tx.billingProfile.upsert({ where: { partyId: id }, create: { partyId: id, ...data, createdBy: actor.id, updatedBy: actor.id }, update: { ...data, updatedBy: actor.id } });
        await this.audit.record({ actorId: actor.id, action: 'billing.customer.updated', targetType: 'party', targetId: id, details: { fields: Object.keys(dto) }, ...client }, tx);
      });
    }
    return (await this.customerViews([id]))[0];
  }

  // ------------------------------------------------------------------------------------------------ overview

  async overview(): Promise<BillingOverviewView> {
    const today = this.today();
    const month = monthOf(today);
    const rows = await this.prisma.invoice.findMany({ where: { status: { in: ['issued', 'draft'] } }, include: invoiceInclude, orderBy: { dueDate: 'asc' } });
    const views = await this.views(rows);
    const live = views.filter((v) => v.status !== 'draft' && v.status !== 'cancelled' && v.entryStatus !== 'rejected');
    const base = (v: BillingInvoiceView, amount: string) => round2(dec(amount).times(v.exchangeRate));
    const open = live.filter((v) => v.status !== 'paid');
    const overdue = open.filter((v) => v.status === 'overdue');
    const months: string[] = [];
    for (let i = 5; i >= 0; i--) months.push(addMonths(`${month}-01`, -i).slice(0, 7));
    const received = await this.prisma.paymentAllocation.findMany({
      where: { invoiceId: { not: null }, payment: { direction: 'received', paymentDate: { gte: dbDate(`${months[0]}-01`) } } },
      select: { amount: true, payment: { select: { paymentDate: true, exchangeRate: true, journalEntryId: true } } },
    });
    const postedIds = new Set(
      (await this.prisma.journalEntry.findMany({ where: { id: { in: received.map((r) => r.payment.journalEntryId!).filter(Boolean) }, status: 'posted' }, select: { id: true } })).map((e) => e.id),
    );
    const collectedIn = (m: string) =>
      sum(received.filter((r) => postedIds.has(r.payment.journalEntryId ?? '') && monthOf(dayOf(r.payment.paymentDate)) === m).map((r) => round2(dec(r.amount).times(r.payment.exchangeRate))));
    const billedIn = (m: string) => sum(live.filter((v) => monthOf(v.issueDate) === m).map((v) => base(v, v.total)));
    const rate = await this.prisma.exchangeRate.findFirst({ where: { currency: 'USD' }, orderBy: { rateDate: 'desc' } });
    const s = await this.settingsValue();
    return {
      billedThisMonth: money(billedIn(month)),
      collectedThisMonth: money(collectedIn(month)),
      outstanding: money(sum(open.map((v) => base(v, v.balance)))),
      overdueCount: overdue.length,
      overdueAmount: money(sum(overdue.map((v) => base(v, v.balance)))),
      upcomingDue: open.filter((v) => v.status !== 'overdue' && v.dueDate <= addDays(today, 14)),
      overdue,
      draftsFromSales: views.filter((v) => v.status === 'draft' && v.sourceDealNumber),
      dealsNeedingClient: await this.dealHandovers('needs_client'),
      drafts: views.filter((v) => v.status === 'draft').length,
      history: months.map((m) => ({ month: m, billed: money(billedIn(m)), collected: money(collectedIn(m)) })),
      usdRate: rate ? dec(rate.rate).toFixed(6) : null,
      customerEmailsEnabled: s.customerEmails.enabled,
    };
  }

  // ------------------------------------------------------------------------------------------------ recurring and rental rules

  async recurringRules(id?: string): Promise<RecurringRuleView[]> {
    const rules = await this.prisma.recurringBillingRule.findMany({
      where: id ? { id } : {},
      include: { party: { select: { name: true } }, _count: { select: { invoices: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rules.map((r) => ({
      id: r.id,
      partyId: r.partyId,
      partyName: r.party.name,
      kind: r.kind as 'recurring' | 'rental',
      period: r.period,
      currency: r.currency,
      total: money(sum((r.lines as unknown as InvoiceLineInput[]).map((l) => round2(dec(l.quantity).times(l.unitPrice))))),
      startDate: dayOf(r.startDate),
      endDate: r.endDate ? dayOf(r.endDate) : null,
      nextPeriodStart: r.status === 'active' ? dayOf(r.nextPeriodStart) : null,
      status: r.status,
      endReason: r.endReason,
      invoiceCount: r._count.invoices,
    }));
  }

  async stopRecurring(actor: Actor, id: string, reason: string, client: RequestInfo): Promise<RecurringRuleView> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.recurringBillingRule.updateMany({ where: { id, status: 'active' }, data: { status: 'ended', endedAt: this.clock.now(), endedBy: actor.id, endReason: reason.trim(), updatedBy: actor.id } });
      if (!count) {
        if (!(await tx.recurringBillingRule.findUnique({ where: { id } }))) throw notFound('Recurring invoice');
        throw conflict('invalid_transition', 'This recurring invoice is already stopped');
      }
      await this.audit.record({ actorId: actor.id, action: 'billing.recurring.stopped', targetType: 'recurring_billing_rule', targetId: id, reason: reason.trim(), ...client }, tx);
    });
    return (await this.recurringRules(id))[0];
  }

  /**
   * Daily job, step 1: each active rule whose next period has started gets one draft for that period (unique per rule and
   * period start, so a re-run or a second server adds nothing) and the assigned person is told to check it.
   */
  async generateRecurring(day: string): Promise<number> {
    let created = 0;
    const due = await this.prisma.recurringBillingRule.findMany({ where: { status: 'active', nextPeriodStart: { lte: dbDate(day) } }, select: { id: true } });
    for (const { id } of due) {
      for (let i = 0; i < MAX_PERIODS_PER_RUN; i++) {
        const made = await withDbRules(() =>
          this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM recurring_billing_rules WHERE id = ${id}::uuid FOR UPDATE`;
            const rule = await tx.recurringBillingRule.findUniqueOrThrow({ where: { id } });
            const start = dayOf(rule.nextPeriodStart);
            if (rule.status !== 'active' || start > day) return 'stop' as const;
            const end = rule.endDate ? dayOf(rule.endDate) : null;
            if (end && start > end) {
              await tx.recurringBillingRule.update({ where: { id }, data: { status: 'ended', endedAt: this.clock.now(), endReason: 'The last period was billed' } });
              return 'stop' as const;
            }
            const next = periodAfter(dayOf(rule.startDate), start, rule.period);
            let periodEnd = addDays(next, -1);
            if (end && end < periodEnd) periodEnd = end;
            const exists = await tx.invoice.findFirst({ where: { recurringRuleId: id, periodStart: dbDate(start) }, select: { id: true } });
            let draftId = exists?.id ?? null;
            if (!exists) {
              const draft = await this.lifecycle.createDraftTx(
                tx,
                null,
                {
                  partyId: rule.partyId,
                  kind: rule.kind,
                  issueDate: start,
                  termsDays: rule.termsDays,
                  currency: rule.currency,
                  notes: rule.notes,
                  lines: rule.lines as unknown as InvoiceLineInput[],
                  periodStart: start,
                  periodEnd,
                  recurringRuleId: id,
                  reminderOffsets: rule.reminderOffsets,
                  assignedToId: rule.assignedToId,
                },
                {},
              );
              draftId = draft.id;
              if (rule.assignedToId) {
                await this.notifications.create(tx, {
                  recipientId: rule.assignedToId,
                  type: 'invoice_draft_ready',
                  title: 'A recurring invoice is ready to check',
                  body: `The ${rule.kind === 'rental' ? 'rental' : 'recurring'} invoice for ${start} to ${periodEnd} was created as a draft. Check it and issue it.`,
                  link: `/billing/invoices/${draft.id}`,
                  dedupeKey: `recurring:${id}:${start}`,
                });
              }
            }
            const ended = !!end && next > end;
            await tx.recurringBillingRule.update({ where: { id }, data: { nextPeriodStart: dbDate(next), ...(ended ? { status: 'ended', endedAt: this.clock.now(), endReason: 'The last period was billed' } : {}) } });
            return draftId && !exists ? ('created' as const) : ('advanced' as const);
          }),
        );
        if (made === 'stop') break;
        if (made === 'created') created++;
      }
    }
    return created;
  }

  // ------------------------------------------------------------------------------------------------ Module 15 connection point

  /**
   * A confirmed Won deal (review decision 5). One handover row per deal number (unique), so a retried or repeated event
   * does nothing. The client:
   *  - the Module 9 client the event names, when it is an active client;
   *  - otherwise the ONE active client whose name is exactly the deal's client name;
   *  - several such clients: NO draft yet; the handover waits for Finance to choose the client (never chosen silently);
   *  - none: a new client marked "needs review" (its invoice cannot be issued until Finance confirms the client).
   * Runs inside the outbox reader's transaction.
   */
  async draftFromWonDeal(tx: Tx, event: { id: string; payload: WonDealPayload }): Promise<{ status: 'drafted' | 'needs_client' | 'duplicate'; invoiceId: string | null }> {
    const p = event.payload;
    if (await tx.dealHandover.findUnique({ where: { dealNumber: p.dealNumber }, select: { id: true } })) return { status: 'duplicate', invoiceId: null };
    if (await tx.invoice.findUnique({ where: { sourceDealNumber: p.dealNumber }, select: { id: true } })) return { status: 'duplicate', invoiceId: null };
    const s = await this.settingsValue(tx);
    const name = p.client.name.trim();
    let partyId: string | null = null;
    if (p.client.partyId) {
      const party = await tx.party.findUnique({ where: { id: p.client.partyId }, select: { kind: true, archivedAt: true } });
      if (party && party.kind === 'client' && !party.archivedAt) partyId = p.client.partyId;
    }
    if (!partyId) {
      const matches = await tx.party.findMany({ where: { kind: 'client', archivedAt: null, name }, select: { id: true }, orderBy: { createdAt: 'asc' } });
      if (matches.length > 1) {
        await tx.dealHandover.create({ data: { dealNumber: p.dealNumber, payload: p as unknown as Prisma.InputJsonValue, status: 'needs_client', candidatePartyIds: matches.map((m) => m.id), sourceEventId: event.id } });
        await this.audit.record({ actorId: null, action: 'billing.deal_handover.needs_client', targetType: 'deal', targetId: p.dealNumber, details: { clientName: name, candidates: matches.length } }, tx);
        for (const person of await this.holders(tx, 'billing.manage')) {
          await this.notifications.create(tx, {
            recipientId: person.id,
            type: 'invoice_draft_ready',
            title: 'A Won deal needs its client chosen',
            body: `Deal ${p.dealNumber}: ${matches.length} clients are called "${name}". Choose the right one on the billing overview; then its draft invoice is made.`,
            link: '/billing',
            dedupeKey: `${event.id}:deal_needs_client`,
            sourceEventId: event.id,
          });
        }
        return { status: 'needs_client', invoiceId: null };
      }
      partyId = matches[0]?.id ?? null;
    }
    if (!partyId) {
      const party = await tx.party.create({ data: { kind: 'client', name, email: p.client.email, country: p.client.country, currency: p.currency } });
      await tx.billingProfile.create({ data: { partyId: party.id, termsDays: s.defaultTermsDays, needsReview: true, createdFromDeal: p.dealNumber } });
      await this.audit.record({ actorId: null, action: 'billing.customer.created', targetType: 'party', targetId: party.id, details: { name, fromDeal: p.dealNumber, needsReview: true } }, tx);
      partyId = party.id;
    }
    const invoiceId = await this.createDealDraft(tx, null, partyId, p, s);
    await tx.dealHandover.create({ data: { dealNumber: p.dealNumber, payload: p as unknown as Prisma.InputJsonValue, status: 'drafted', candidatePartyIds: [], invoiceId, sourceEventId: event.id } });
    for (const person of await this.holders(tx, 'billing.manage')) {
      await this.notifications.create(tx, {
        recipientId: person.id,
        type: 'invoice_draft_ready',
        title: 'A Won deal is ready to invoice',
        body: `Deal ${p.dealNumber} was confirmed as Won. Its draft invoice waits for you to check and issue.`,
        link: `/billing/invoices/${invoiceId}`,
        dedupeKey: `${event.id}:invoice_draft_ready`,
        sourceEventId: event.id,
      });
    }
    return { status: 'drafted', invoiceId };
  }

  private async createDealDraft(tx: Tx, actorId: string | null, partyId: string, p: WonDealPayload, s: BillingSettings): Promise<string> {
    const profile = await tx.billingProfile.findUnique({ where: { partyId }, select: { termsDays: true } });
    const owner = await tx.employee.findUnique({ where: { empId: p.ownerEmpId }, select: { id: true } });
    const draft = await this.lifecycle.createDraftTx(
      tx,
      actorId,
      {
        partyId,
        kind: 'one_time',
        issueDate: this.today(),
        termsDays: profile?.termsDays ?? s.defaultTermsDays,
        currency: p.currency,
        notes: `Created automatically from Won deal ${p.dealNumber}. Check the scope and amount, then issue it.`,
        lines: await this.resolveLines(tx, [{ description: p.service, quantity: '1', unitPrice: p.value }], s),
        reminderOffsets: s.reminderOffsets,
        assignedToId: null,
        sourceDealNumber: p.dealNumber,
        sourceDealOwnerId: owner?.id ?? null,
      },
      {},
    );
    return draft.id;
  }

  async dealHandovers(status: 'drafted' | 'needs_client' | 'all' = 'needs_client', db: Db = this.prisma): Promise<DealHandoverView[]> {
    const rows = await db.dealHandover.findMany({ where: status === 'all' ? {} : { status }, orderBy: { createdAt: 'asc' } });
    const parties = await db.party.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.candidatePartyIds))] } }, select: { id: true, name: true, email: true, country: true } });
    const byId = new Map(parties.map((x) => [x.id, x]));
    return rows.map((r) => {
      const p = r.payload as unknown as WonDealPayload;
      return {
        id: r.id,
        dealNumber: r.dealNumber,
        status: r.status,
        clientName: p.client.name,
        service: p.service,
        value: money(p.value),
        currency: p.currency,
        ownerEmpId: p.ownerEmpId,
        candidates: r.candidatePartyIds.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x),
        invoiceId: r.invoiceId,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  /** Finance chooses the client of a Won deal whose client name matched several clients; its draft invoice is made now (once). */
  async resolveDealHandover(actor: Actor, id: string, partyId: string, client: RequestInfo): Promise<DealHandoverView> {
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM deal_handovers WHERE id = ${id}::uuid FOR UPDATE`;
        const h = await tx.dealHandover.findUnique({ where: { id } });
        if (!h) throw notFound('Won deal');
        if (h.status !== 'needs_client') throw conflict('already_resolved', 'The client of this Won deal was already chosen');
        await this.docs.partyOf(tx, partyId, 'client');
        const p = h.payload as unknown as WonDealPayload;
        const invoiceId = await this.createDealDraft(tx, actor.id, partyId, p, await this.settingsValue(tx));
        await tx.dealHandover.update({ where: { id }, data: { status: 'drafted', invoiceId, resolvedBy: actor.id, resolvedAt: this.clock.now() } });
        await this.audit.record(
          { actorId: actor.id, action: 'billing.deal_handover.resolved', targetType: 'deal', targetId: h.dealNumber, details: { partyId, wasCandidate: h.candidatePartyIds.includes(partyId), candidates: h.candidatePartyIds.length }, ...client },
          tx,
        );
      }),
    );
    return (await this.dealHandovers('all')).find((x) => x.id === id)!;
  }

  /** Finance has reviewed a client that was created automatically from a Won deal; its invoices can now be issued. */
  async confirmCustomer(actor: Actor, id: string, client: RequestInfo): Promise<BillingCustomerView> {
    await this.prisma.$transaction(async (tx) => {
      const profile = await tx.billingProfile.findUnique({ where: { partyId: id } });
      if (!profile) throw notFound('Client');
      if (!profile.needsReview) throw conflict('already_reviewed', 'This client does not need a review');
      await tx.billingProfile.update({ where: { partyId: id }, data: { needsReview: false, updatedBy: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'billing.customer.reviewed', targetType: 'party', targetId: id, details: { fromDeal: profile.createdFromDeal }, ...client }, tx);
    });
    return (await this.customerViews([id]))[0];
  }

  /** People holding a permission through their role or an active duty. */
  holders(tx: Db, permission: string): Promise<Array<{ id: string; empId: string }>> {
    return tx.$queryRaw<Array<{ id: string; empId: string }>>`
      SELECT DISTINCT e.id, e.emp_id AS "empId"
      FROM employees e
      WHERE e.status <> 'left' AND (
        EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = e.role_id AND p.key = ${permission})
        OR EXISTS (SELECT 1 FROM employee_duties ed JOIN duty_permissions dp ON dp.duty_id = ed.duty_id JOIN permissions p ON p.id = dp.permission_id
                   WHERE ed.employee_id = e.id AND ed.ended_at IS NULL AND p.key = ${permission}))
      ORDER BY "empId"`;
  }
}

/** Values are escaped. Company details come from the billing settings; a detail that is not set is left out. */
export function renderInvoiceHtml(inv: BillingInvoiceView, customer: BillingCustomerView, s: BillingSettings): string {
  const esc = (v: string | null | undefined) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const c = s.company;
  const companyLines = [c.address, c.email, c.phone, c.taxNumbers].filter((x): x is string => !!x).map(esc).join('<br>');
  const statusLabel: Record<BillingInvoiceStatus, string> = { draft: 'Draft', issued: 'Issued', part_paid: 'Part paid', paid: 'Paid', overdue: 'Overdue', cancelled: 'Cancelled' };
  const rows = inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="n">${esc(l.quantity)}</td><td class="n">${esc(l.unitPrice)}</td><td class="n">${esc(l.amount)}</td></tr>`).join('');
  const period = inv.periodStart ? ` &middot; Period: ${esc(inv.periodStart)} to ${esc(inv.periodEnd)}` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice ${esc(inv.number)}</title>
<style>body{font-family:system-ui,sans-serif;margin:40px;color:#111}h1{margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:24px}
th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left}.n{text-align:right}.muted{color:#666;font-size:12px}.tot td{font-weight:700}</style></head>
<body>
<header><h1>${esc(c.legalName ?? 'Aceva')}</h1>${companyLines ? `<div class="muted">${companyLines}</div>` : `<div class="muted">Company details are not set in the billing settings yet.</div>`}</header>
<h2>Invoice ${esc(inv.number)}</h2>
<p><strong>Bill to:</strong> ${esc(customer.name)}${customer.contactName ? `<br>${esc(customer.contactName)}` : ''}${customer.address ? `<br>${esc(customer.address)}` : ''}${customer.email ? `<br>${esc(customer.email)}` : ''}${customer.taxId ? `<br>Tax ID: ${esc(customer.taxId)}` : ''}</p>
<p>Issue date: ${esc(inv.issueDate)} &middot; Due date: ${esc(inv.dueDate)} &middot; Currency: ${esc(inv.currency)} &middot; Status: ${esc(statusLabel[inv.status])}${period}</p>
<table><thead><tr><th>Description</th><th class="n">Quantity</th><th class="n">Unit price</th><th class="n">Amount</th></tr></thead>
<tbody>${rows}<tr class="tot"><td colspan="3">Total (${esc(inv.currency)})</td><td class="n">${esc(inv.total)}</td></tr>
<tr><td colspan="3">Paid</td><td class="n">${esc(inv.paid)}</td></tr><tr><td colspan="3">Balance</td><td class="n">${esc(inv.balance)}</td></tr></tbody></table>
${c.paymentDetails ? `<h3>How to pay</h3><p>${esc(c.paymentDetails).replace(/\n/g, '<br>')}</p>` : ''}
${inv.notes ? `<p>${esc(inv.notes)}</p>` : ''}
</body></html>`;
}
