import { Injectable, Logger } from '@nestjs/common';
import type { CreateSalaryAdvanceRequest, SalaryAdvanceView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { withDbRules } from '../common/db-rules';
import { dec, money, sum } from '../common/money';
import { pkDate } from '../common/pakistan-time';
import { LedgerPostingPort } from '../finance/ledger-posting.port';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest, conflict, notFound, type Db } from './payroll-common';
import type { AdvanceInput } from './payroll-calc';

const advanceInclude = { repayments: { select: { amount: true } }, employee: { select: { empId: true, fullName: true } } } as const;

/**
 * Salary advances (plan section 12: "with a repayment plan that is deducted automatically each month").
 * An advance is paid out through a Module 9 journal entry (Dr employee advances / Cr bank) that waits for the normal ledger
 * approval; payroll deducts repayments only once that entry is POSTED. Who approves an advance beyond the ledger approval,
 * and the maximum advance, are not decided yet (D10).
 */
@Injectable()
export class AdvancesService {
  private readonly logger = new Logger('PayrollAdvances');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerPostingPort,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async create(actor: Actor, dto: CreateSalaryAdvanceRequest, client: RequestInfo): Promise<SalaryAdvanceView> {
    const employee = await this.prisma.employee.findUnique({ where: { empId: dto.empId }, select: { id: true, empId: true, status: true } });
    if (!employee) notFound('Employee not found');
    if (employee!.status === 'left') conflict('employee_left', 'This person has left the company');
    if (dec(dto.monthlyDeduction).gt(dec(dto.amount))) badRequest('invalid_advance', 'The monthly deduction cannot be more than the advance');
    const bank = await this.ledger.findBankAccount(dto.bankAccountId);
    if (!bank) badRequest('invalid_bank_account', 'Choose an active bank account');

    const id = await withDbRules(() =>
      this.prisma.$transaction(
        async (tx) => {
          const advance = await tx.salaryAdvance.create({
            data: { employeeId: employee!.id, amount: dto.amount, monthlyDeduction: dto.monthlyDeduction, startMonth: dto.startMonth, reason: dto.reason, createdBy: actor.id, updatedBy: actor.id },
          });
          const entry = await this.ledger.createSystemEntry(tx, {
            source: 'advance',
            sourceRef: advance.id,
            purpose: 'payout',
            entryDate: pkDate(this.clock.now()),
            description: `Salary advance to ${employee!.empId}`,
            makerId: actor.id,
            lines: [
              { accountRole: 'employee_advances', debit: dec(dto.amount), employeeId: employee!.id, description: `Salary advance ${employee!.empId}` },
              { accountId: bank!.id, credit: dec(dto.amount), description: `Salary advance ${employee!.empId}` },
            ],
          });
          await tx.salaryAdvance.update({ where: { id: advance.id }, data: { payoutEntryId: entry.id } });
          await this.audit.record(
            { actorId: actor.id, action: 'payroll.advance.created', targetType: 'salary_advance', targetId: advance.id, details: { empId: employee!.empId, startMonth: dto.startMonth, payoutEntry: entry.number }, ...client },
            tx,
          );
          return advance.id;
        },
        { timeout: 30_000 },
      ),
    );
    const [view] = await this.views({ id });
    return view;
  }

  /** Every advance (payroll.view), newest first; optionally one person's. */
  async list(empId?: string): Promise<SalaryAdvanceView[]> {
    await this.refreshPayouts();
    return this.views(empId ? { employee: { empId } } : {});
  }

  /** The caller's own advances. */
  async mine(actor: Actor): Promise<SalaryAdvanceView[]> {
    await this.refreshPayouts();
    return this.views({ employeeId: actor.id });
  }

  /**
   * Moves advances whose payout entry was posted to `active` (payroll may now deduct repayments), and those whose payout
   * entry was rejected to `cancelled` (nothing was paid, so nothing is repaid).
   */
  async refreshPayouts(): Promise<void> {
    const waiting = await this.prisma.salaryAdvance.findMany({ where: { status: 'pending_payout', payoutEntryId: { not: null } }, select: { id: true, payoutEntryId: true } });
    if (!waiting.length) return;
    const statuses = await this.ledger.entryStatuses(waiting.map((w) => w.payoutEntryId!));
    for (const w of waiting) {
      const status = statuses.get(w.payoutEntryId!)?.status;
      if (status === 'posted' || status === 'rejected') {
        await this.prisma.salaryAdvance.updateMany({ where: { id: w.id, status: 'pending_payout' }, data: { status: status === 'posted' ? 'active' : 'cancelled' } });
      }
    }
  }

  /** Active advances repaid in a month's payroll, per employee, oldest first, with what remains. */
  async activeFor(db: Db, employeeIds: string[], month: string): Promise<Map<string, AdvanceInput[]>> {
    const rows = await db.salaryAdvance.findMany({
      where: { employeeId: { in: employeeIds }, status: 'active', startMonth: { lte: month } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { repayments: { select: { amount: true } } },
    });
    const out = new Map<string, AdvanceInput[]>();
    for (const r of rows) {
      const remaining = dec(r.amount).minus(sum(r.repayments.map((p) => p.amount)));
      if (remaining.lte(0)) continue;
      const list = out.get(r.employeeId) ?? [];
      list.push({ id: r.id, monthlyDeduction: r.monthlyDeduction, remaining });
      out.set(r.employeeId, list);
    }
    return out;
  }

  private async views(where: Record<string, unknown>): Promise<SalaryAdvanceView[]> {
    const rows = await this.prisma.salaryAdvance.findMany({ where, orderBy: { createdAt: 'desc' }, include: advanceInclude });
    const entryIds = rows.map((r) => r.payoutEntryId).filter((v): v is string => !!v);
    const statuses = entryIds.length ? await this.ledger.entryStatuses(entryIds).catch((e) => (this.logger.warn(`Entry statuses unavailable: ${(e as Error).message}`), new Map())) : new Map();
    const makers = await this.prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.createdBy).filter((v): v is string => !!v) } }, select: { id: true, empId: true } });
    const makerEmp = new Map(makers.map((m) => [m.id, m.empId]));
    return rows.map((r) => {
      const repaid = sum(r.repayments.map((p) => p.amount));
      const entry = r.payoutEntryId ? statuses.get(r.payoutEntryId) : undefined;
      return {
        id: r.id,
        empId: r.employee.empId,
        name: r.employee.fullName,
        amount: money(r.amount),
        monthlyDeduction: money(r.monthlyDeduction),
        startMonth: r.startMonth,
        repaid: money(repaid),
        remaining: money(dec(r.amount).minus(repaid)),
        status: r.status,
        reason: r.reason,
        payoutEntry: entry ? { number: entry.number, status: entry.status } : null,
        createdBy: r.createdBy ? (makerEmp.get(r.createdBy) ?? null) : null,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }
}
