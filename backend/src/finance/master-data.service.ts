import { Injectable } from '@nestjs/common';
import type { AccountView, ApprovalLimitView, BankAccountView, ExchangeRateView, FinanceSettingsView, PartyView, ProjectView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { CryptoService } from '../auth/crypto.service';
import { StepUpService } from '../auth/step-up.service';
import { isUniqueViolation, withDbRules } from '../common/db-rules';
import { dec, money, ZERO } from '../common/money';
import { dayOf, dbDate } from '../common/pakistan-time';
import type { Currency, LedgerAccount, Party, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest, conflict, forbidden, notFound } from './finance-errors';
import { LedgerQueryService, naturalSign } from './ledger-query.service';

const mask = (last4: string | null | undefined) => (last4 ? `•••• ${last4}` : null);

/**
 * Chart of accounts, bank accounts, clients and vendors, projects, exchange rates, approval limits and finance settings.
 * The chart here is a DEVELOPMENT chart: the accountant owns the real one (plan section 13); changes are logged.
 */
@Injectable()
export class MasterDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly stepUp: StepUpService,
    private readonly ledger: LedgerQueryService,
  ) {}

  // ------------------------------------------------------------------------------------------------- chart of accounts

  async accounts(): Promise<AccountView[]> {
    const [rows, balances] = await Promise.all([
      this.prisma.ledgerAccount.findMany({ orderBy: { code: 'asc' }, include: { children: { where: { archivedAt: null }, select: { id: true }, take: 1 } } }),
      this.ledger.balances(),
    ]);
    return rows.map((a) => this.accountView(a, a.children.length > 0, balances.get(a.id)));
  }

  private accountView(a: LedgerAccount, isHeader: boolean, b?: { baseDebit: Prisma.Decimal; baseCredit: Prisma.Decimal; foreign: Prisma.Decimal }): AccountView {
    const sign = naturalSign(a.group);
    return {
      id: a.id,
      code: a.code,
      name: a.name,
      group: a.group,
      parentId: a.parentId,
      currency: a.currency,
      isBank: a.isBank,
      isHeader,
      requiresOwnerApproval: a.requiresOwnerApproval,
      isOci: a.isOci,
      systemRole: a.systemRole,
      active: !a.archivedAt,
      balance: money(b ? b.baseDebit.minus(b.baseCredit).times(sign) : 0),
      foreignBalance: a.currency === 'USD' ? money(b ? b.foreign.times(sign) : 0) : null,
    };
  }

  async createAccount(
    actor: Actor,
    dto: { code: string; name: string; group: AccountView['group']; parentId?: string; currency: Currency; requiresOwnerApproval?: boolean; isOci?: boolean },
    client: RequestInfo,
    bank?: { bankName: string; accountNumber: string },
  ): Promise<AccountView> {
    // Plan s.13: all share capital and loan entries need the Owner. Equity accounts carry the flag unless the Owner decides
    // otherwise; only the Owner may create a capital-group account without it (security review, finding 1).
    const parent = dto.parentId ? await this.prisma.ledgerAccount.findUnique({ where: { id: dto.parentId }, include: { _count: { select: { lines: true } } } }) : null;
    // A sub-account of an account that needs Owner approval (for example under 2500 Loans) needs it too; it cannot be
    // switched off (decision D22; the database enforces the same rule).
    if (parent?.requiresOwnerApproval && dto.requiresOwnerApproval === false) {
      throw conflict('owner_approval_inherited', `Account ${parent.code} needs Owner approval, so its sub-accounts need it too`);
    }
    const ownerFlag = parent?.requiresOwnerApproval ? true : (dto.requiresOwnerApproval ?? dto.group === 'equity');
    if (!ownerFlag && dto.group === 'equity' && actor.levelNumber !== 1) {
      throw forbidden('owner_only', 'Only the Owner may create an equity account that does not need Owner approval');
    }
    if (dto.parentId) {
      if (!parent || parent.archivedAt) throw badRequest('unknown_account', 'The parent account does not exist');
      if (parent.group !== dto.group) throw badRequest('invalid_parent', 'The parent account must be in the same group');
      if (parent._count.lines > 0) throw conflict('parent_has_postings', 'The parent account already has postings; it cannot become a group header');
    }
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const a = await tx.ledgerAccount.create({
          data: {
            code: dto.code,
            name: dto.name.trim(),
            group: dto.group,
            parentId: dto.parentId ?? null,
            currency: dto.currency,
            isBank: !!bank,
            requiresOwnerApproval: ownerFlag,
            isOci: dto.isOci ?? false,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        if (bank) await this.writeBankDetails(tx, a.id, bank, actor.id);
        await this.audit.record(
          { actorId: actor.id, action: bank ? 'finance.bank_account.created' : 'finance.account.created', targetType: 'ledger_account', targetId: a.code, details: { group: a.group, currency: a.currency, name: a.name }, ...client },
          tx,
        );
        return a;
      });
      return this.accountView(created, false);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('code_taken', `Account code ${dto.code} is already used`);
      throw error;
    }
  }

  async updateAccount(actor: Actor, id: string, dto: { name?: string; archived?: boolean; requiresOwnerApproval?: boolean; isOci?: boolean; reason: string }, client: RequestInfo): Promise<AccountView> {
    const a = await this.prisma.ledgerAccount.findUnique({ where: { id } });
    if (!a) throw notFound('Account');
    if (dto.archived === true && !a.archivedAt) {
      if (a.systemRole) throw conflict('system_account', `Account ${a.code} is used by automatic postings (${a.systemRole}); map the role to another account first`);
      const balance = (await this.ledger.balances({}, [id])).get(id);
      if (balance && !balance.baseDebit.equals(balance.baseCredit)) throw conflict('account_has_balance', `Account ${a.code} still has a balance`);
      const open = await this.prisma.journalLine.count({ where: { accountId: id, entry: { status: { in: ['draft', 'pending_approval'] } } } });
      if (open) throw conflict('account_in_use', `Account ${a.code} is used by entries that are not posted yet`);
    }
    const data: Prisma.LedgerAccountUpdateInput = { updatedBy: actor.id };
    const changed: Record<string, unknown> = {};
    if (dto.name !== undefined && dto.name.trim() !== a.name) {
      data.name = dto.name.trim();
      changed.name = { from: a.name, to: dto.name.trim() };
    }
    if (dto.archived !== undefined && dto.archived !== !!a.archivedAt) {
      data.archivedAt = dto.archived ? new Date() : null;
      changed.archived = dto.archived;
    }
    if (dto.requiresOwnerApproval !== undefined && dto.requiresOwnerApproval !== a.requiresOwnerApproval) {
      // Removing the "Owner approves" rule loosens an approval rule: it is never done here, only by the Owner through
      // PUT /accounts/:id/owner-approval with "confirm again" (decision D22). Adding it is allowed.
      if (!dto.requiresOwnerApproval) throw forbidden('owner_only', 'Only the Owner removes the Owner-approval rule (Owner approval settings)');
      data.requiresOwnerApproval = dto.requiresOwnerApproval;
      changed.requiresOwnerApproval = dto.requiresOwnerApproval;
    }
    if (dto.isOci !== undefined && dto.isOci !== a.isOci) {
      data.isOci = dto.isOci;
      changed.isOci = dto.isOci;
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.ledgerAccount.update({ where: { id }, data });
      await this.audit.record({ actorId: actor.id, action: 'finance.account.updated', targetType: 'ledger_account', targetId: a.code, reason: dto.reason, details: changed as Prisma.InputJsonValue, ...client }, tx);
      return row;
    });
    const children = await this.prisma.ledgerAccount.count({ where: { parentId: id, archivedAt: null } });
    return this.accountView(updated, children > 0, (await this.ledger.balances({}, [id])).get(id));
  }

  /**
   * The Owner adds or removes the "Owner approves" rule on an account (decision D22), after confirming again. Removing it
   * is refused for a sub-account whose parent needs Owner approval (inherited). The database accepts the removal only
   * with this audit row, made by an Owner, in the same transaction.
   */
  async setOwnerApproval(actor: Actor, id: string, dto: { required: boolean; reason: string }, sessionId: string | null, client: RequestInfo): Promise<AccountView> {
    if (actor.levelNumber !== 1) throw forbidden('owner_only', 'Only the Owner changes the Owner-approval rule');
    const a = await this.prisma.ledgerAccount.findUnique({ where: { id }, include: { parent: { select: { code: true, requiresOwnerApproval: true } } } });
    if (!a) throw notFound('Account');
    if (!dto.required && a.parent?.requiresOwnerApproval) {
      throw conflict('owner_approval_inherited', `Account ${a.parent.code} needs Owner approval, so ${a.code} needs it too`);
    }
    await this.stepUp.require(actor, sessionId, 'finance.account.owner_approval', { type: 'ledger_account', id: a.code }, client);
    if (dto.required !== a.requiresOwnerApproval) {
      await withDbRules(() =>
        this.prisma.$transaction(async (tx) => {
          await this.audit.record(
            {
              actorId: actor.id,
              action: dto.required ? 'finance.account.owner_approval_added' : 'finance.account.owner_approval_removed',
              targetType: 'ledger_account',
              targetId: a.code,
              reason: dto.reason,
              details: { requiresOwnerApproval: dto.required },
              ...client,
            },
            tx,
          );
          await tx.ledgerAccount.update({ where: { id }, data: { requiresOwnerApproval: dto.required, updatedBy: actor.id } });
        }),
      );
    }
    const updated = await this.prisma.ledgerAccount.findUniqueOrThrow({ where: { id } });
    const children = await this.prisma.ledgerAccount.count({ where: { parentId: id, archivedAt: null } });
    return this.accountView(updated, children > 0, (await this.ledger.balances({}, [id])).get(id));
  }

  // ------------------------------------------------------------------------------------------------- bank accounts

  async bankAccounts(): Promise<BankAccountView[]> {
    const rows = await this.prisma.ledgerAccount.findMany({ where: { isBank: true }, include: { bank: true }, orderBy: { code: 'asc' } });
    const balances = await this.ledger.balances({}, rows.map((r) => r.id));
    return rows.map((a) => {
      const b = balances.get(a.id);
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        currency: a.currency,
        bankName: a.bank?.bankName ?? null,
        accountNumberMasked: mask(a.bank?.accountNumberLast4),
        active: !a.archivedAt,
        balance: money(b ? b.baseDebit.minus(b.baseCredit) : 0),
        foreignBalance: a.currency === 'USD' ? money(b?.foreign ?? 0) : null,
      };
    });
  }

  async createBankAccount(actor: Actor, dto: { code: string; name: string; currency: Currency; bankName: string; accountNumber: string }, client: RequestInfo) {
    await this.createAccount(actor, { code: dto.code, name: dto.name, group: 'asset', currency: dto.currency }, client, { bankName: dto.bankName, accountNumber: dto.accountNumber });
    return (await this.bankAccounts()).find((b) => b.code === dto.code)!;
  }

  async setBankDetails(actor: Actor, id: string, dto: { bankName: string; accountNumber: string; reason: string }, client: RequestInfo) {
    const a = await this.prisma.ledgerAccount.findUnique({ where: { id } });
    if (!a || !a.isBank) throw notFound('Bank account');
    await this.prisma.$transaction(async (tx) => {
      await this.writeBankDetails(tx, id, dto, actor.id);
      // Never the number in the log: only that it changed.
      await this.audit.record({ actorId: actor.id, action: 'finance.bank_account.details_changed', targetType: 'ledger_account', targetId: a.code, reason: dto.reason, details: { bankName: dto.bankName.trim() }, ...client }, tx);
    });
    return (await this.bankAccounts()).find((b) => b.id === id)!;
  }

  private async writeBankDetails(tx: Prisma.TransactionClient, accountId: string, d: { bankName: string; accountNumber: string }, actorId: string) {
    const number = d.accountNumber.replace(/\s+/g, '').trim();
    const data = { bankName: d.bankName.trim(), accountNumberEncrypted: this.crypto.encrypt(number), accountNumberLast4: number.slice(-4), updatedBy: actorId };
    await tx.bankAccountDetail.upsert({ where: { accountId }, create: { accountId, ...data, createdBy: actorId }, update: data });
  }

  /** The full account number: "confirm again" first, and every reveal is logged (the number never is). */
  async revealBankNumber(actor: Actor, id: string, sessionId: string | null, client: RequestInfo): Promise<{ value: string }> {
    const a = await this.prisma.ledgerAccount.findUnique({ where: { id }, include: { bank: true } });
    if (!a || !a.isBank) throw notFound('Bank account');
    await this.stepUp.require(actor, sessionId, 'finance.bank_number.reveal', { type: 'ledger_account', id: a.code }, client);
    if (!a.bank) throw notFound('Bank details');
    const value = this.crypto.decrypt(a.bank.accountNumberEncrypted);
    await this.audit.record({ actorId: actor.id, action: 'finance.bank_number.revealed', targetType: 'ledger_account', targetId: a.code, ...client });
    return { value };
  }

  // ------------------------------------------------------------------------------------------------- clients and vendors

  async parties(q: { page: number; pageSize: number; kind?: 'client' | 'vendor'; q?: string; includeArchived?: 'true' | 'false' }) {
    const where: Prisma.PartyWhereInput = {
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.includeArchived === 'true' ? {} : { archivedAt: null }),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.party.count({ where }),
      this.prisma.party.findMany({ where, orderBy: [{ kind: 'asc' }, { name: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { items: await this.partyViews(rows), total, page: q.page, pageSize: q.pageSize };
  }

  async party(id: string): Promise<PartyView> {
    const p = await this.prisma.party.findUnique({ where: { id } });
    if (!p) throw notFound('Client or vendor');
    return (await this.partyViews([p]))[0];
  }

  /** Balance = posted lines tagged with the party on the receivable (clients) or payable (vendors) account. */
  private async partyViews(rows: Party[]): Promise<PartyView[]> {
    if (!rows.length) return [];
    const roles = await this.prisma.ledgerAccount.findMany({ where: { systemRole: { in: ['accounts_receivable', 'accounts_payable'] } }, select: { id: true, systemRole: true } });
    const sums = await this.prisma.journalLine.groupBy({
      by: ['partyId', 'accountId'],
      where: { partyId: { in: rows.map((r) => r.id) }, accountId: { in: roles.map((r) => r.id) }, entry: { status: 'posted' } },
      _sum: { baseDebit: true, baseCredit: true },
    });
    const ar = roles.find((r) => r.systemRole === 'accounts_receivable')?.id;
    const ap = roles.find((r) => r.systemRole === 'accounts_payable')?.id;
    return rows.map((p) => {
      let balance = ZERO;
      for (const s of sums.filter((x) => x.partyId === p.id)) {
        const net = dec(s._sum.baseDebit).minus(dec(s._sum.baseCredit));
        if (p.kind === 'client' && s.accountId === ar) balance = balance.plus(net);
        if (p.kind === 'vendor' && s.accountId === ap) balance = balance.minus(net);
      }
      return { id: p.id, kind: p.kind, name: p.name, email: p.email, phone: p.phone, country: p.country, address: p.address, currency: p.currency, active: !p.archivedAt, balance: money(balance) };
    });
  }

  async createParty(actor: Actor, dto: { kind: 'client' | 'vendor'; name: string; email?: string; phone?: string; country?: string; address?: string; currency: Currency }, client: RequestInfo): Promise<PartyView> {
    const p = await this.prisma.$transaction(async (tx) => {
      const row = await tx.party.create({ data: { ...dto, name: dto.name.trim(), createdBy: actor.id, updatedBy: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'finance.party.created', targetType: 'party', targetId: row.id, details: { kind: row.kind, name: row.name }, ...client }, tx);
      return row;
    });
    return (await this.partyViews([p]))[0];
  }

  async updateParty(actor: Actor, id: string, dto: { name?: string; email?: string; phone?: string; country?: string; address?: string; currency?: Currency; archived?: boolean }, client: RequestInfo): Promise<PartyView> {
    const existing = await this.prisma.party.findUnique({ where: { id } });
    if (!existing) throw notFound('Client or vendor');
    const { archived, ...fields } = dto;
    const p = await this.prisma.$transaction(async (tx) => {
      const row = await tx.party.update({
        where: { id },
        data: { ...fields, ...(archived === undefined ? {} : { archivedAt: archived ? (existing.archivedAt ?? new Date()) : null }), updatedBy: actor.id },
      });
      await this.audit.record({ actorId: actor.id, action: archived ? 'finance.party.archived' : 'finance.party.updated', targetType: 'party', targetId: id, details: { fields: Object.keys(dto) }, ...client }, tx);
      return row;
    });
    return (await this.partyViews([p]))[0];
  }

  // ------------------------------------------------------------------------------------------------- projects

  async projects(includeArchived = false): Promise<ProjectView[]> {
    const rows = await this.prisma.financeProject.findMany({ where: includeArchived ? {} : { archivedAt: null }, orderBy: { code: 'asc' } });
    return rows.map((p) => ({ id: p.id, code: p.code, name: p.name, active: !p.archivedAt }));
  }

  async createProject(actor: Actor, dto: { code: string; name: string }, client: RequestInfo): Promise<ProjectView> {
    try {
      const p = await this.prisma.$transaction(async (tx) => {
        const row = await tx.financeProject.create({ data: { code: dto.code.toUpperCase(), name: dto.name.trim(), createdBy: actor.id, updatedBy: actor.id } });
        await this.audit.record({ actorId: actor.id, action: 'finance.project.created', targetType: 'finance_project', targetId: row.code, ...client }, tx);
        return row;
      });
      return { id: p.id, code: p.code, name: p.name, active: true };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('code_taken', `Project code ${dto.code} is already used`);
      throw error;
    }
  }

  async updateProject(actor: Actor, id: string, dto: { name?: string; archived?: boolean }, client: RequestInfo): Promise<ProjectView> {
    const existing = await this.prisma.financeProject.findUnique({ where: { id } });
    if (!existing) throw notFound('Project');
    const p = await this.prisma.$transaction(async (tx) => {
      const row = await tx.financeProject.update({
        where: { id },
        data: { ...(dto.name ? { name: dto.name.trim() } : {}), ...(dto.archived === undefined ? {} : { archivedAt: dto.archived ? (existing.archivedAt ?? new Date()) : null }), updatedBy: actor.id },
      });
      await this.audit.record({ actorId: actor.id, action: 'finance.project.updated', targetType: 'finance_project', targetId: row.code, details: { fields: Object.keys(dto) }, ...client }, tx);
      return row;
    });
    return { id: p.id, code: p.code, name: p.name, active: !p.archivedAt };
  }

  // ------------------------------------------------------------------------------------------------- exchange rates

  async rates(from?: string, to?: string): Promise<ExchangeRateView[]> {
    const rows = await this.prisma.exchangeRate.findMany({
      where: { ...(from || to ? { rateDate: { ...(from ? { gte: dbDate(from) } : {}), ...(to ? { lte: dbDate(to) } : {}) } } : {}) },
      orderBy: { rateDate: 'desc' },
      take: 400,
    });
    return rows.map((r) => ({ id: r.id, date: dayOf(r.rateDate), currency: 'USD' as const, rate: dec(r.rate).toFixed(6), source: r.source }));
  }

  /** One rate per currency per day. A saved rate is not changed later (each entry keeps the rate it used anyway). */
  async createRate(actor: Actor, dto: { date: string; rate: string; source?: string }, client: RequestInfo): Promise<ExchangeRateView> {
    try {
      const r = await this.prisma.$transaction(async (tx) => {
        const row = await tx.exchangeRate.create({ data: { currency: 'USD', rateDate: dbDate(dto.date), rate: dec(dto.rate), source: dto.source ?? null, createdBy: actor.id } });
        await this.audit.record({ actorId: actor.id, action: 'finance.rate.created', targetType: 'exchange_rate', targetId: `USD:${dto.date}`, details: { rate: dec(dto.rate).toFixed(6) }, ...client }, tx);
        return row;
      });
      return { id: r.id, date: dayOf(r.rateDate), currency: 'USD', rate: dec(r.rate).toFixed(6), source: r.source };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('rate_exists', `A USD rate is already saved for ${dto.date}`);
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------------------- settings (temporary home until Module 12)

  async approvalLimits(): Promise<ApprovalLimitView[]> {
    const rows = await this.prisma.approvalLimit.findMany({ orderBy: { approverLevel: 'desc' } });
    return rows.map((r) => ({ approverLevel: r.approverLevel, maxAmount: r.maxAmount === null ? null : money(r.maxAmount), label: r.label }));
  }

  /**
   * Replaces the tiers. Rules: one row per level; exactly one tier without a limit, and it is the most senior level; a more
   * senior level always has a higher limit. Entries already waiting keep the tier stored when they were submitted.
   */
  async setApprovalLimits(
    actor: Actor,
    dto: { limits: Array<{ approverLevel: number; maxAmount: string | null; label: string }>; reason: string },
    sessionId: string | null,
    client: RequestInfo,
  ): Promise<ApprovalLimitView[]> {
    const limits = [...dto.limits].sort((a, b) => b.approverLevel - a.approverLevel);
    if (new Set(limits.map((l) => l.approverLevel)).size !== limits.length) throw badRequest('invalid_limits', 'One tier per level');
    const unlimited = limits.filter((l) => l.maxAmount === null);
    if (unlimited.length !== 1 || unlimited[0] !== limits[limits.length - 1]) throw badRequest('invalid_limits', 'Exactly one tier has no upper limit, and it is the most senior level');
    // Plan s.13: the Owner approves above the CEO limit. The unlimited tier is always level 1, so nobody below the Owner can
    // be given unlimited approval (security review, finding 2).
    if (unlimited[0].approverLevel !== 1) throw badRequest('invalid_limits', 'The tier without an upper limit is the Owner (level 1)');
    for (let i = 1; i < limits.length - 1; i++) {
      if (!dec(limits[i].maxAmount!).gt(dec(limits[i - 1].maxAmount!))) throw badRequest('invalid_limits', 'A more senior level must have a higher limit');
    }
    // Decision D22: only the Owner changes approval limits (also by permission: finance.authority_manage).
    if (actor.levelNumber !== 1) throw forbidden('owner_only', 'Only the Owner changes approval limits');
    await this.stepUp.require(actor, sessionId, 'finance.approval_limits.change', { type: 'settings', id: 'approval_limits' }, client);
    const before = await this.approvalLimits();
    await this.prisma.$transaction(async (tx) => {
      await tx.approvalLimit.deleteMany({ where: { approverLevel: { notIn: limits.map((l) => l.approverLevel) } } });
      for (const l of limits) {
        const data = { maxAmount: l.maxAmount === null ? null : dec(l.maxAmount), label: l.label.trim(), updatedBy: actor.id };
        await tx.approvalLimit.upsert({ where: { approverLevel: l.approverLevel }, create: { approverLevel: l.approverLevel, ...data, createdBy: actor.id }, update: data });
      }
      await this.audit.record({ actorId: actor.id, action: 'finance.approval_limits.changed', targetType: 'settings', targetId: 'approval_limits', reason: dto.reason, details: { before, after: limits } as unknown as Prisma.InputJsonValue, ...client }, tx);
    });
    return this.approvalLimits();
  }

  async financeSettings(): Promise<FinanceSettingsView> {
    const s = await this.prisma.financeSetting.findUnique({ where: { id: 1 } });
    if (!s) throw notFound('Finance settings');
    return { stepUpAbove: money(s.stepUpAbove), financeYearStartMonth: s.financeYearStartMonth };
  }

  async setFinanceSettings(actor: Actor, dto: { stepUpAbove: string; financeYearStartMonth: number; reason: string }, sessionId: string | null, client: RequestInfo): Promise<FinanceSettingsView> {
    // Decision D22: only the Owner changes finance-wide security settings (also by permission: finance.authority_manage).
    if (actor.levelNumber !== 1) throw forbidden('owner_only', 'Only the Owner changes finance security settings');
    await this.stepUp.require(actor, sessionId, 'finance.settings.change', { type: 'settings', id: 'finance' }, client);
    const before = await this.financeSettings();
    await this.prisma.$transaction(async (tx) => {
      await tx.financeSetting.upsert({
        where: { id: 1 },
        create: { id: 1, stepUpAbove: dec(dto.stepUpAbove), financeYearStartMonth: dto.financeYearStartMonth, updatedBy: actor.id },
        update: { stepUpAbove: dec(dto.stepUpAbove), financeYearStartMonth: dto.financeYearStartMonth, updatedBy: actor.id },
      });
      await this.audit.record(
        { actorId: actor.id, action: 'finance.settings.changed', targetType: 'settings', targetId: 'finance', reason: dto.reason, details: { before: { ...before }, after: { stepUpAbove: money(dto.stepUpAbove), financeYearStartMonth: dto.financeYearStartMonth } }, ...client },
        tx,
      );
    });
    return this.financeSettings();
  }
}
