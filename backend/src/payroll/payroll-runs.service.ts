import { Injectable, Logger } from '@nestjs/common';
import type {
  AddPayrollItemRequest,
  CreatePayrollAdjustmentRequest,
  MarkPayrollPaidRequest,
  PayrollAdjustmentView,
  PayrollItemView,
  PayrollLedgerEntryRef,
  PayrollLineFlag,
  PayrollLineView,
  PayrollRunLinesResponse,
  PayrollRunView,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { AttendancePayrollPort } from '../attendance/attendance-payroll.port';
import { CryptoService } from '../auth/crypto.service';
import { StepUpService } from '../auth/step-up.service';
import { Clock } from '../common/clock';
import { isUniqueViolation, withDbRules } from '../common/db-rules';
import { dec, money, round2 } from '../common/money';
import { dayOf, dbDate, firstDayOfMonth, lastDayOfMonth, monthOf, pkDate } from '../common/pakistan-time';
import { OutboxService } from '../events/outbox.service';
import { LedgerPostingPort, SYSTEM_ACCOUNT_ROLES, type SystemEntryLine, type SystemEntryResult } from '../finance/ledger-posting.port';
import type { PayrollLine, PayrollRun, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdvancesService } from './advances.service';
import { FinalSettlementService } from './final-settlement.service';
import { allocateAdvanceDeduction, calculateLine, grossOf, runTotals, salaryEntryLines } from './payroll-calc';
import { badRequest, conflict, employedInMonthWhere, forbidden, iso, notFound, peopleByIds, UUID_PATTERN } from './payroll-common';
import { TaxSlabsService } from './tax-slabs.service';

type Tx = Prisma.TransactionClient;
const EDITABLE = ['draft', 'calculated'];
const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 };

const ROLE_FOR: Record<string, SystemEntryLine['accountRole']> = {
  salary_expense: SYSTEM_ACCOUNT_ROLES.salaryExpense,
  tax_payable: SYSTEM_ACCOUNT_ROLES.taxPayable,
  employee_advances: SYSTEM_ACCOUNT_ROLES.employeeAdvances,
  payroll_deductions: SYSTEM_ACCOUNT_ROLES.payrollDeductions,
  salary_payable: SYSTEM_ACCOUNT_ROLES.salaryPayable,
};

/**
 * The monthly payroll run (plan section 12):
 *   draft -> calculated (attendance locked through Module 7, every salary calculated; may be calculated again)
 *         -> prepared (the finance duty person prepares the draft and checks it)
 *         -> reviewed (the Director reviews it; never the preparer)
 *         -> approved (the CEO approves it after confirming their password again; never the preparer).
 * Approval issues the payslips, takes the advance repayments and creates the salary entry in Module 9, all in one transaction;
 * that entry then waits for the normal ledger approval (decision P7/D5). A run can be sent back to `calculated` from prepared
 * or reviewed. An approved run never changes (database trigger): mistakes are fixed by an adjustment in a later month.
 *
 * No salary amount or bank number is ever written to the audit log, the outbox or the server log.
 */
@Injectable()
export class PayrollRunsService {
  private readonly logger = new Logger('Payroll');

  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: AttendancePayrollPort,
    private readonly ledger: LedgerPostingPort,
    private readonly taxSlabs: TaxSlabsService,
    private readonly advances: AdvancesService,
    private readonly settlements: FinalSettlementService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly stepUp: StepUpService,
    private readonly permissions: PermissionService,
    private readonly crypto: CryptoService,
    private readonly clock: Clock,
  ) {}

  // ============================================================================================================ reading

  async list(): Promise<PayrollRunView[]> {
    const runs = await this.prisma.payrollRun.findMany({ orderBy: { month: 'desc' } });
    return this.views(runs);
  }

  async get(idOrNumber: string): Promise<PayrollRunView> {
    const [view] = await this.views([await this.findRun(idOrNumber)]);
    return view;
  }

  /** The run with every salary line. A sensitive view: audited (without any amount). */
  async lines(actor: Actor, idOrNumber: string, client: RequestInfo): Promise<PayrollRunLinesResponse> {
    const run = await this.findRun(idOrNumber);
    const [view] = await this.views([run]);
    const lines = await this.lineViews(run);
    await this.audit.record({ actorId: actor.id, action: 'payroll.run.viewed', targetType: 'payroll_run', targetId: run.number, details: { runNumber: run.number, lines: lines.length }, ...client });
    return { run: view, lines };
  }

  // ============================================================================================================ workflow

  async create(actor: Actor, month: string, client: RequestInfo): Promise<PayrollRunView> {
    if (month > monthOf(pkDate(this.clock.now()))) badRequest('future_month', 'A payroll run can only be started for this month or an earlier one');
    if (await this.prisma.payrollRun.findUnique({ where: { month } })) conflict('run_exists', `There is already a payroll run for ${month}`);
    const run = await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.payrollRun.create({ data: { number: `PR-${month}`, month, createdBy: actor.id, updatedBy: actor.id } });
        await this.audit.record({ actorId: actor.id, action: 'payroll.run.created', targetType: 'payroll_run', targetId: created.number, details: { month }, ...client }, tx);
        return created;
      })
      .catch((e: unknown) => (isUniqueViolation(e) ? conflict('run_exists', `There is already a payroll run for ${month}`) : Promise.reject(e)));
    return this.get(run.id);
  }

  /** Locks the month's attendance (Module 7) and (re)calculates every line. Allowed while draft or calculated. */
  async calculate(actor: Actor, idOrNumber: string, client: RequestInfo): Promise<PayrollRunView> {
    const run = await this.findRun(idOrNumber);
    this.requireEditable(run);
    await this.settlements.consume();
    await this.advances.refreshPayouts();
    await withDbRules(() => this.prisma.$transaction((tx) => this.calculateInTx(tx, actor, run.id, client), TX_OPTIONS));
    return this.get(run.id);
  }

  async addItem(actor: Actor, idOrNumber: string, dto: AddPayrollItemRequest, client: RequestInfo): Promise<PayrollItemView> {
    const run = await this.findRun(idOrNumber);
    this.requireEditable(run);
    const employee = await this.prisma.employee.findFirst({ where: { empId: dto.empId, ...employedInMonthWhere(run.month), pay: { isNot: null } }, select: { id: true, empId: true } });
    if (!employee) conflict('not_in_run', `${dto.empId} is not in the ${run.month} payroll`);
    if (run.stage === 'calculated') await this.advances.refreshPayouts();
    const item = await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const stage = await this.lockRun(tx, run.id);
        if (!EDITABLE.includes(stage)) this.requireEditable({ ...run, stage: stage as PayrollRun['stage'] });
        const created = await tx.payrollItem.create({ data: { runId: run.id, employeeId: employee.id, kind: dto.kind, source: 'manual', label: dto.label, amount: dto.amount, createdBy: actor.id } });
        // A calculated run is calculated again at once, so its lines and totals always match its items.
        if (stage === 'calculated') await this.calculateInTx(tx, actor, run.id, client);
        await this.audit.record({ actorId: actor.id, action: 'payroll.item.added', targetType: 'payroll_run', targetId: run.number, details: { runNumber: run.number, empId: employee.empId, kind: dto.kind }, ...client }, tx);
        return created;
      }, TX_OPTIONS),
    );
    return { id: item.id, empId: employee.empId, kind: item.kind, source: item.source, label: item.label, amount: money(item.amount), createdAt: item.createdAt.toISOString() };
  }

  async deleteItem(actor: Actor, idOrNumber: string, itemId: string, client: RequestInfo): Promise<void> {
    const run = await this.findRun(idOrNumber);
    this.requireEditable(run);
    const item = await this.prisma.payrollItem.findFirst({ where: { id: itemId, runId: run.id }, include: { employee: { select: { empId: true } } } });
    if (!item) notFound('Payroll item not found');
    if (item.source !== 'manual') conflict('adjustment_item', 'Adjustment and commission lines are applied automatically and cannot be removed here');
    if (run.stage === 'calculated') await this.advances.refreshPayouts();
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const stage = await this.lockRun(tx, run.id);
        if (!EDITABLE.includes(stage)) this.requireEditable({ ...run, stage: stage as PayrollRun['stage'] });
        await tx.payrollItem.delete({ where: { id: item.id } });
        if (stage === 'calculated') await this.calculateInTx(tx, actor, run.id, client);
        await this.audit.record({ actorId: actor.id, action: 'payroll.item.removed', targetType: 'payroll_run', targetId: run.number, details: { runNumber: run.number, empId: item.employee.empId, kind: item.kind }, ...client }, tx);
      }, TX_OPTIONS),
    );
  }

  /** The finance duty person "prepares the draft and checks it" (from calculated). */
  async prepare(actor: Actor, idOrNumber: string, client: RequestInfo): Promise<PayrollRunView> {
    const run = await this.findRun(idOrNumber);
    if (run.stage !== 'calculated') conflict('invalid_transition', 'Only a calculated run can be prepared');
    const lineEmployees = await this.prisma.payrollLine.findMany({ where: { runId: run.id }, select: { employeeId: true } });
    if (!lineEmployees.length) conflict('empty_run', 'This run has no salary lines');
    const waiting = await this.prisma.payrollAdjustment.count({ where: { targetMonth: run.month, item: { is: null }, employeeId: { in: lineEmployees.map((l) => l.employeeId) } } });
    if (waiting) conflict('recalculate_needed', 'Adjustments were added for this month after it was calculated. Calculate it again first');
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.payrollRun.updateMany({
        where: { id: run.id, stage: 'calculated' },
        data: { stage: 'prepared', preparedBy: actor.id, preparedAt: now, reviewedBy: null, reviewedAt: null, returnedNote: null, updatedBy: actor.id },
      });
      if (!changed.count) conflict('state_changed', 'This run was changed by someone else. Reload it');
      await this.outbox.emit({ type: 'payroll.run.ready', actor: actor.empId, payload: { runNumber: run.number, month: run.month, stage: 'prepared' } }, tx);
      await this.audit.record({ actorId: actor.id, action: 'payroll.run.prepared', targetType: 'payroll_run', targetId: run.number, details: { runNumber: run.number }, ...client }, tx);
    });
    return this.get(run.id);
  }

  /** The Director reviews a prepared run. The preparer never reviews it (maker-checker). */
  async review(actor: Actor, idOrNumber: string, client: RequestInfo): Promise<PayrollRunView> {
    const run = await this.findRun(idOrNumber);
    if (run.stage !== 'prepared') conflict('invalid_transition', 'Only a prepared run can be reviewed');
    if (run.preparedBy === actor.id) forbidden('maker_checker', 'You prepared this payroll, so you cannot review it');
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.payrollRun.updateMany({ where: { id: run.id, stage: 'prepared', preparedBy: { not: actor.id } }, data: { stage: 'reviewed', reviewedBy: actor.id, reviewedAt: now, updatedBy: actor.id } });
      if (!changed.count) conflict('state_changed', 'This run was changed by someone else. Reload it');
      await this.outbox.emit({ type: 'payroll.run.ready', actor: actor.empId, payload: { runNumber: run.number, month: run.month, stage: 'reviewed' } }, tx);
      await this.audit.record({ actorId: actor.id, action: 'payroll.run.reviewed', targetType: 'payroll_run', targetId: run.number, details: { runNumber: run.number }, ...client }, tx);
    });
    return this.get(run.id);
  }

  /**
   * The CEO approves a reviewed run, after confirming their password (and code) again. Never the preparer. In ONE transaction:
   * advance repayments, payslips, final settlements settled, the salary entry in Module 9 (which then waits for the ledger
   * approval), the stage change and the events.
   */
  async approve(actor: Actor, sessionId: string | null, idOrNumber: string, client: RequestInfo): Promise<PayrollRunView> {
    const run = await this.findRun(idOrNumber);
    if (run.stage !== 'reviewed') conflict('invalid_transition', 'Only a reviewed run can be approved');
    if (run.preparedBy === actor.id) forbidden('maker_checker', 'You prepared this payroll, so you cannot approve it');
    // Plan s.12: the Director reviews and the CEO approves: two different people (security review, finding 4).
    if (run.reviewedBy === actor.id) forbidden('maker_checker', 'You reviewed this payroll, so a different person approves it');
    await this.stepUp.require(actor, sessionId, 'approve_payroll', { type: 'payroll_run', id: run.number }, client);
    const now = this.clock.now();
    const first = firstDayOfMonth(run.month);
    const last = lastDayOfMonth(run.month);

    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const stage = await this.lockRun(tx, run.id);
        if (stage !== 'reviewed') conflict('state_changed', 'This run was changed by someone else. Reload it');
        const lines = await tx.payrollLine.findMany({ where: { runId: run.id }, include: { employee: { select: { empId: true } } }, orderBy: { employee: { empId: 'asc' } } });
        if (!lines.length) conflict('empty_run', 'This run has no salary lines');

        // Advance repayments: split each line's advance deduction over that person's advances, oldest first. The advance rows
        // are locked first, so two runs approved at the same moment cannot both take the same remaining amount.
        const employeeIds = lines.map((l) => l.employeeId);
        await tx.$queryRaw`SELECT id FROM salary_advances WHERE employee_id = ANY(${employeeIds}::uuid[]) AND status = 'active' ORDER BY id FOR UPDATE`;
        const advances = await this.advances.activeFor(tx, employeeIds, run.month);
        for (const line of lines) {
          if (!dec(line.advanceDeduction).gt(0)) continue;
          const own = advances.get(line.employeeId) ?? [];
          const takes = allocateAdvanceDeduction(line.advanceDeduction, own);
          if (!takes) conflict('advances_changed', `The salary advance of ${line.employee.empId} changed after this run was calculated. Send it back and calculate it again`);
          for (const take of takes) {
            await tx.advanceRepayment.create({ data: { advanceId: take.advanceId, runId: run.id, amount: take.amount } });
            const advance = own.find((a) => a.id === take.advanceId)!;
            if (dec(advance.remaining).minus(take.amount).lte(0)) {
              await tx.salaryAdvance.updateMany({ where: { id: take.advanceId, status: 'active' }, data: { status: 'repaid', updatedBy: actor.id } });
            }
          }
        }

        // One payslip per line (insert-only; the printable document is produced from the line when it is opened).
        await tx.payslip.createMany({ data: lines.map((l) => ({ runId: run.id, lineId: l.id, employeeId: l.employeeId, month: run.month, issuedAt: now })) });

        // Leavers whose final salary is in this run.
        await tx.finalSettlement.updateMany({
          where: { employeeId: { in: lines.map((l) => l.employeeId) }, settledAt: null, lastWorkingDay: { gte: dbDate(first), lte: dbDate(last) } },
          data: { settledAt: now, runId: run.id },
        });

        // The salary entry in Module 9 (Dr salary expense / Cr tax, advances, deductions, salary payable).
        const entryLines = salaryEntryLines(runTotals(lines));
        let entry: SystemEntryResult | null = null;
        if (entryLines.length >= 2) {
          entry = await this.ledger.createSystemEntry(tx, {
            source: 'payroll',
            sourceRef: run.id,
            purpose: 'salary',
            entryDate: last,
            description: `Salaries for ${run.month} (${run.number})`,
            makerId: run.preparedBy!,
            lines: entryLines.map((l) => ({
              accountRole: ROLE_FOR[l.role],
              ...(l.side === 'debit' ? { debit: l.amount } : { credit: l.amount }),
              description: `Payroll ${run.number}`,
            })),
          });
        }

        const changed = await tx.payrollRun.updateMany({
          where: { id: run.id, stage: 'reviewed', preparedBy: { not: actor.id }, reviewedBy: { not: actor.id } },
          data: { stage: 'approved', approvedBy: actor.id, approvedAt: now, journalEntryId: entry?.id ?? null, updatedBy: actor.id },
        });
        if (!changed.count) conflict('state_changed', 'This run was changed by someone else. Reload it');

        await this.outbox.emit({ type: 'payroll.run.approved', actor: actor.empId, payload: { runNumber: run.number, month: run.month, approvedByEmpId: actor.empId } }, tx);
        for (const l of lines) await this.outbox.emit({ type: 'payslip.issued', actor: actor.empId, payload: { empId: l.employee.empId, month: run.month } }, tx);
        await this.audit.record(
          { actorId: actor.id, action: 'payroll.run.approved', targetType: 'payroll_run', targetId: run.number, details: { runNumber: run.number, headcount: lines.length, salaryEntry: entry?.number ?? null }, ...client },
          tx,
        );
      }, TX_OPTIONS),
    );
    return this.get(run.id);
  }

  /** Sent back to Finance (to `calculated`) with a reason, by the Director or the CEO. */
  async returnRun(actor: Actor, idOrNumber: string, reason: string, client: RequestInfo): Promise<PayrollRunView> {
    const access = await this.permissions.getEffectiveAccess(actor.id);
    if (!access.permissions.has('payroll.review') && !access.permissions.has('payroll.approve')) forbidden('forbidden', 'Only the reviewer or the approver can send a run back');
    const run = await this.findRun(idOrNumber);
    if (run.stage !== 'prepared' && run.stage !== 'reviewed') conflict('invalid_transition', 'Only a prepared or reviewed run can be sent back');
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.payrollRun.updateMany({
        where: { id: run.id, stage: run.stage },
        data: { stage: 'calculated', returnedNote: reason, preparedBy: null, preparedAt: null, reviewedBy: null, reviewedAt: null, updatedBy: actor.id },
      });
      if (!changed.count) conflict('state_changed', 'This run was changed by someone else. Reload it');
      await this.audit.record({ actorId: actor.id, action: 'payroll.run.returned', targetType: 'payroll_run', targetId: run.number, reason, details: { runNumber: run.number, from: run.stage }, ...client }, tx);
    });
    return this.get(run.id);
  }

  /** The bank transfer was made: a payment entry (Dr salary payable / Cr bank) clears salary payable. Once per run. */
  async markPaid(actor: Actor, idOrNumber: string, dto: MarkPayrollPaidRequest, client: RequestInfo): Promise<PayrollRunView> {
    const run = await this.findRun(idOrNumber);
    if (run.stage !== 'approved') conflict('invalid_transition', 'Only an approved run can be marked as paid');
    if (run.paymentEntryId) conflict('already_paid', 'The bank transfer for this run is already recorded');
    if (dto.paidOn < firstDayOfMonth(run.month)) badRequest('invalid_date', 'The transfer cannot be dated before the payroll month');
    if (dto.paidOn > pkDate(this.clock.now())) badRequest('invalid_date', 'The transfer cannot be dated in the future');
    const bank = await this.ledger.findBankAccount(dto.bankAccountId);
    if (!bank) badRequest('invalid_bank_account', 'Choose an active bank account');
    if (run.journalEntryId) {
      const salary = (await this.ledger.entryStatuses([run.journalEntryId])).get(run.journalEntryId);
      if (salary?.status === 'rejected') conflict('salary_entry_rejected', 'The salary entry of this run was rejected in the ledger; sort that out first');
    }
    const lines = await this.prisma.payrollLine.findMany({ where: { runId: run.id } });
    const net = runTotals(lines).net;
    if (!net.gt(0)) conflict('nothing_to_pay', 'This run has no net pay to transfer');
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lockRun(tx, run.id);
        const fresh = await tx.payrollRun.findUniqueOrThrow({ where: { id: run.id }, select: { paymentEntryId: true } });
        if (fresh.paymentEntryId) conflict('already_paid', 'The bank transfer for this run is already recorded');
        const entry = await this.ledger.createSystemEntry(tx, {
          source: 'payroll_payment',
          sourceRef: run.id,
          purpose: 'payment',
          entryDate: dto.paidOn,
          description: `Salary transfer for ${run.month} (${run.number})`,
          makerId: actor.id,
          lines: [
            { accountRole: SYSTEM_ACCOUNT_ROLES.salaryPayable, debit: net, description: `Payroll ${run.number}` },
            { accountId: bank.id, credit: net, description: `Payroll ${run.number}` },
          ],
        });
        const changed = await tx.payrollRun.updateMany({ where: { id: run.id, stage: 'approved', paymentEntryId: null }, data: { paymentEntryId: entry.id, paymentRecordedAt: this.clock.now(), updatedBy: actor.id } });
        if (!changed.count) conflict('already_paid', 'The bank transfer for this run is already recorded');
        await this.audit.record({ actorId: actor.id, action: 'payroll.run.paid', targetType: 'payroll_run', targetId: run.number, details: { runNumber: run.number, paymentEntry: entry.number, paidOn: dto.paidOn }, ...client }, tx);
      }, TX_OPTIONS),
    );
    return this.get(run.id);
  }

  /**
   * The bank transfer sheet (plan section 12: "marked highly confidential and logged"): CSV with full account numbers.
   * Approved runs only; needs payroll.export and a fresh "confirm again". The audit row names the run and the row count only.
   */
  async bankSheet(actor: Actor, sessionId: string | null, idOrNumber: string, client: RequestInfo): Promise<{ fileName: string; csv: string }> {
    const run = await this.findRun(idOrNumber);
    if (run.stage !== 'approved') conflict('run_not_approved', 'The bank sheet is available once the run is approved');
    await this.stepUp.require(actor, sessionId, 'export_bank_sheet', { type: 'payroll_run', id: run.number }, client);
    const lines = await this.prisma.payrollLine.findMany({
      where: { runId: run.id },
      include: { employee: { select: { empId: true, fullName: true, pay: { select: { bankName: true, bankAccountEncrypted: true } } } } },
      orderBy: { employee: { empId: 'asc' } },
    });
    const exportedAt = this.clock.now();
    const rows = [
      [`HIGHLY CONFIDENTIAL - ${run.number} bank transfer sheet - exported by ${actor.empId} on ${exportedAt.toISOString()}`],
      ['Emp-ID', 'Name', 'Bank', 'Account number', 'Net pay (PKR)'],
      ...lines.map((l) => [
        l.employee.empId,
        l.employee.fullName,
        l.employee.pay?.bankName ?? '',
        l.employee.pay?.bankAccountEncrypted ? this.crypto.decrypt(l.employee.pay.bankAccountEncrypted) : '',
        money(l.net),
      ]),
      ['', '', '', 'Total', money(runTotals(lines).net)],
    ];
    await this.audit.record({ actorId: actor.id, action: 'payroll.bank_sheet.exported', targetType: 'payroll_run', targetId: run.number, details: { runNumber: run.number, rows: lines.length, format: 'csv' }, ...client });
    return { fileName: `${run.number}-bank-sheet-HIGHLY-CONFIDENTIAL.csv`, csv: rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n' };
  }

  // ========================================================================================================= adjustments

  async createAdjustment(actor: Actor, dto: CreatePayrollAdjustmentRequest, client: RequestInfo): Promise<PayrollAdjustmentView> {
    const origin = UUID_PATTERN.test(dto.originRunId) ? await this.prisma.payrollRun.findUnique({ where: { id: dto.originRunId } }) : null;
    if (!origin) notFound('Payroll run not found');
    if (origin.stage !== 'approved') conflict('run_not_approved', 'A run that is not approved yet is corrected directly, not with an adjustment');
    if (dto.targetMonth <= origin.month) badRequest('invalid_target_month', 'An adjustment goes into a later month than the run it corrects');
    const employee = await this.prisma.employee.findUnique({ where: { empId: dto.empId }, select: { id: true, empId: true } });
    const line = employee ? await this.prisma.payrollLine.findUnique({ where: { runId_employeeId: { runId: origin.id, employeeId: employee.id } }, select: { id: true } }) : null;
    if (!employee || !line) badRequest('not_in_run', `${dto.empId} was not in ${origin.number}`);
    const target = await this.prisma.payrollRun.findUnique({ where: { month: dto.targetMonth } });
    if (target && !EDITABLE.includes(target.stage)) conflict('target_run_closed', `The ${dto.targetMonth} run is already prepared; choose a later month`);
    const created = await this.prisma.$transaction(async (tx) => {
      const adj = await tx.payrollAdjustment.create({ data: { employeeId: employee.id, targetMonth: dto.targetMonth, originRunId: origin.id, kind: dto.kind, amount: dto.amount, reason: dto.reason, createdBy: actor.id } });
      await this.audit.record(
        { actorId: actor.id, action: 'payroll.adjustment.created', targetType: 'payroll_adjustment', targetId: adj.id, reason: dto.reason, details: { empId: employee.empId, originRun: origin.number, targetMonth: dto.targetMonth, kind: dto.kind }, ...client },
        tx,
      );
      return adj;
    });
    const [view] = await this.adjustmentViews({ id: created.id });
    return view;
  }

  async listAdjustments(month?: string): Promise<PayrollAdjustmentView[]> {
    return this.adjustmentViews(month ? { targetMonth: month } : {});
  }

  // ============================================================================================================ internals

  async findRun(idOrNumber: string): Promise<PayrollRun> {
    const run = UUID_PATTERN.test(idOrNumber)
      ? await this.prisma.payrollRun.findUnique({ where: { id: idOrNumber } })
      : await this.prisma.payrollRun.findUnique({ where: { number: idOrNumber } });
    if (!run) notFound('Payroll run not found');
    return run;
  }

  private requireEditable(run: Pick<PayrollRun, 'stage'>): void {
    if (!EDITABLE.includes(run.stage)) conflict('invalid_transition', 'This run is prepared: it can only be changed after it is sent back');
  }

  /** Locks the run row for this transaction and returns its current stage. */
  private async lockRun(tx: Tx, runId: string): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ stage: string }>>`SELECT stage::text AS stage FROM payroll_runs WHERE id = ${runId}::uuid FOR UPDATE`;
    if (!rows.length) notFound('Payroll run not found');
    return rows[0].stage;
  }

  /** The calculation itself, inside the caller's transaction (see the class comment and payroll-calc.ts). */
  private async calculateInTx(tx: Tx, actor: Actor, runId: string, client: RequestInfo): Promise<void> {
    const stage = await this.lockRun(tx, runId);
    if (!EDITABLE.includes(stage)) conflict('invalid_transition', 'This run is prepared: it can only be changed after it is sent back');
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    const month = run.month;
    const first = firstDayOfMonth(month);
    const last = lastDayOfMonth(month);

    const slabSet = await this.taxSlabs.inForce(month, tx);
    if (!slabSet) conflict('tax_slabs_missing', `No income tax slabs are in force for ${month}. Enter them in Settings first`);

    // Plan section 12: "attendance and leave for the month are locked" (Module 7, idempotent, in this transaction).
    await this.attendance.lockMonth(month, actor.id, tx);

    const employees = await tx.employee.findMany({
      where: { ...employedInMonthWhere(month), pay: { isNot: null } },
      select: { id: true, empId: true, joiningDate: true, lastWorkingDay: true, pay: { select: { baseSalary: true, allowances: true } } },
      orderBy: { empId: 'asc' },
    });
    const ids = employees.map((e) => e.id);
    const summaries = ids.length ? await this.attendance.monthSummary(month, ids, tx) : [];
    const summaryOf = new Map(summaries.map((s) => [s.employeeId, s]));
    const workingDays = summaries[0]?.workingDays ?? (await this.attendance.workingDays(first, last));

    // Adjustments aimed at this month become items of this run (once: an adjustment has at most one item).
    const pending = await tx.payrollAdjustment.findMany({ where: { targetMonth: month, item: { is: null }, employeeId: { in: ids } }, orderBy: { createdAt: 'asc' } });
    for (const a of pending) {
      await tx.payrollItem.create({ data: { runId, employeeId: a.employeeId, kind: a.kind, source: 'adjustment', label: `Adjustment: ${a.reason}`.slice(0, 120), amount: a.amount, adjustmentId: a.id, createdBy: actor.id } });
    }
    const items = await tx.payrollItem.findMany({ where: { runId } });
    const advances = await this.advances.activeFor(tx, ids, month);
    const settling = new Set(
      (await tx.finalSettlement.findMany({ where: { employeeId: { in: ids }, lastWorkingDay: { gte: dbDate(first), lte: dbDate(last) } }, select: { employeeId: true } })).map((f) => f.employeeId),
    );

    const data: Prisma.PayrollLineCreateManyInput[] = [];
    for (const e of employees) {
      const s = summaryOf.get(e.id);
      if (!s) conflict('attendance_summary_missing', `The attendance of ${e.empId} for ${month} could not be read`);
      const own = items.filter((i) => i.employeeId === e.id);
      const r = calculateLine(
        {
          base: e.pay!.baseSalary,
          allowances: e.pay!.allowances,
          bonuses: own.filter((i) => i.kind === 'bonus').map((i) => i.amount),
          deductions: own.filter((i) => i.kind === 'deduction').map((i) => i.amount),
          workingDays: s.workingDays,
          unpaidDays: s.unpaidLeaveDays,
          advances: advances.get(e.id) ?? [],
        },
        slabSet.slabs,
      );
      if (r.net.isNegative()) conflict('negative_net', `The net pay of ${e.empId} would be below zero. Lower the deductions or the advance repayment first`, { empId: e.empId });
      const flags: PayrollLineFlag[] = [];
      if (dayOf(e.joiningDate) > first) flags.push('joined_mid_month');
      if (e.lastWorkingDay && dayOf(e.lastWorkingDay) < last) flags.push('left_mid_month');
      if (settling.has(e.id)) flags.push('final_settlement');
      if (r.noWorkingDays) flags.push('no_working_days');
      if (s.missedCheckouts > 0) flags.push('missed_checkouts');
      data.push({
        runId,
        employeeId: e.id,
        baseSalary: r.base,
        allowances: r.allowances,
        bonus: r.bonus,
        unpaidDays: r.unpaidDays,
        unpaidDeduction: r.unpaidDeduction,
        taxableIncome: r.taxableIncome,
        tax: r.tax,
        advanceDeduction: r.advanceDeduction,
        otherDeductions: r.otherDeductions,
        net: round2(r.net),
        workingDays: s.workingDays,
        presentDays: s.presentDays,
        lateDays: s.lateDays,
        absentDays: s.absentDays,
        flags,
      });
    }

    await tx.payrollLine.deleteMany({ where: { runId } });
    if (data.length) await tx.payrollLine.createMany({ data });
    await tx.payrollRun.update({ where: { id: runId }, data: { stage: 'calculated', workingDays, taxSlabSetId: slabSet.id, calculatedAt: this.clock.now(), updatedBy: actor.id } });
    await this.audit.record(
      { actorId: actor.id, action: 'payroll.run.calculated', targetType: 'payroll_run', targetId: run.number, details: { runNumber: run.number, headcount: data.length, taxSlabs: slabSet.label }, ...client },
      tx,
    );
  }

  private async views(runs: PayrollRun[]): Promise<PayrollRunView[]> {
    if (!runs.length) return [];
    const runIds = runs.map((r) => r.id);
    const sums = await this.prisma.payrollLine.groupBy({
      by: ['runId'],
      where: { runId: { in: runIds } },
      _sum: { baseSalary: true, allowances: true, bonus: true, unpaidDeduction: true, tax: true, advanceDeduction: true, otherDeductions: true, net: true },
      _count: { _all: true },
    });
    const sumOf = new Map(sums.map((s) => [s.runId, s]));
    const people = await peopleByIds(this.prisma, runs.flatMap((r) => [r.preparedBy, r.reviewedBy, r.approvedBy]));
    const entryIds = runs.flatMap((r) => [r.journalEntryId, r.paymentEntryId]).filter((v): v is string => !!v);
    const statuses = await this.entryStatuses(entryIds);
    const slabSets = await this.prisma.taxSlabSet.findMany({ where: { id: { in: runs.map((r) => r.taxSlabSetId).filter((v): v is string => !!v) } } });
    const slabOf = new Map(slabSets.map((s) => [s.id, s]));

    const out: PayrollRunView[] = [];
    for (const r of runs) {
      const s = sumOf.get(r.id)?._sum;
      const gross = dec(s?.baseSalary).plus(dec(s?.allowances)).plus(dec(s?.bonus)).minus(dec(s?.unpaidDeduction));
      const tax = dec(s?.tax);
      const advance = dec(s?.advanceDeduction);
      const other = dec(s?.otherDeductions);
      const open = r.stage !== 'approved';
      const missing = open ? await this.missingPay(r.month) : [];
      const pendingAdjustments = open ? await this.prisma.payrollAdjustment.count({ where: { targetMonth: r.month, item: { is: null } } }) : 0;
      const set = r.taxSlabSetId ? slabOf.get(r.taxSlabSetId) : undefined;
      const ref = (id: string | null): PayrollLedgerEntryRef | null => (id && statuses.get(id) ? { number: statuses.get(id)!.number, status: statuses.get(id)!.status } : null);
      out.push({
        id: r.id,
        number: r.number,
        month: r.month,
        stage: r.stage,
        paid: !!r.paymentEntryId,
        workingDays: r.workingDays,
        headcount: sumOf.get(r.id)?._count._all ?? 0,
        totals: { gross: money(gross), tax: money(tax), advanceDeductions: money(advance), otherDeductions: money(other), deductions: money(tax.plus(advance).plus(other)), net: money(s?.net) },
        taxSlabSet: set ? { id: set.id, label: set.label, effectiveFrom: dayOf(set.effectiveFrom) } : null,
        calculatedAt: iso(r.calculatedAt),
        preparedBy: r.preparedBy ? (people.get(r.preparedBy) ?? null) : null,
        preparedAt: iso(r.preparedAt),
        reviewedBy: r.reviewedBy ? (people.get(r.reviewedBy) ?? null) : null,
        reviewedAt: iso(r.reviewedAt),
        approvedBy: r.approvedBy ? (people.get(r.approvedBy) ?? null) : null,
        approvedAt: iso(r.approvedAt),
        returnedNote: r.returnedNote,
        salaryEntry: ref(r.journalEntryId),
        paymentEntry: ref(r.paymentEntryId),
        paymentRecordedAt: iso(r.paymentRecordedAt),
        createdAt: r.createdAt.toISOString(),
        missingPay: missing,
        pendingAdjustments,
        next: nextStep(r),
      });
    }
    return out;
  }

  private async missingPay(month: string): Promise<Array<{ empId: string; name: string }>> {
    const rows = await this.prisma.employee.findMany({ where: { ...employedInMonthWhere(month), pay: { is: null } }, select: { empId: true, fullName: true }, orderBy: { empId: 'asc' } });
    return rows.map((r) => ({ empId: r.empId, name: r.fullName }));
  }

  private async lineViews(run: PayrollRun): Promise<PayrollLineView[]> {
    const lines = await this.prisma.payrollLine.findMany({ where: { runId: run.id }, include: { employee: { select: { empId: true, fullName: true } } }, orderBy: { employee: { empId: 'asc' } } });
    const items = await this.prisma.payrollItem.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } });
    const previous = await this.prisma.payrollRun.findFirst({ where: { month: { lt: run.month } }, orderBy: { month: 'desc' }, select: { id: true } });
    const previousNet = new Map(
      previous ? (await this.prisma.payrollLine.findMany({ where: { runId: previous.id }, select: { employeeId: true, net: true } })).map((l) => [l.employeeId, money(l.net)] as const) : [],
    );
    const empIdOf = new Map(lines.map((l) => [l.employeeId, l.employee.empId]));
    return lines.map((l) => lineView(l, empIdOf, items, previousNet.get(l.employeeId) ?? null));
  }

  private async adjustmentViews(where: Prisma.PayrollAdjustmentWhereInput): Promise<PayrollAdjustmentView[]> {
    const rows = await this.prisma.payrollAdjustment.findMany({ where, orderBy: { createdAt: 'desc' }, include: { employee: { select: { empId: true, fullName: true } }, item: { select: { id: true } } } });
    const origins = await this.prisma.payrollRun.findMany({ where: { id: { in: rows.map((r) => r.originRunId).filter((v): v is string => !!v) } }, select: { id: true, number: true } });
    const originOf = new Map(origins.map((o) => [o.id, o.number]));
    const people = await peopleByIds(this.prisma, rows.map((r) => r.createdBy));
    return rows.map((r) => ({
      id: r.id,
      empId: r.employee.empId,
      name: r.employee.fullName,
      originRunNumber: r.originRunId ? (originOf.get(r.originRunId) ?? null) : null,
      targetMonth: r.targetMonth,
      kind: r.kind,
      amount: money(r.amount),
      reason: r.reason,
      applied: !!r.item,
      createdBy: r.createdBy ? (people.get(r.createdBy)?.empId ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private async entryStatuses(ids: string[]): Promise<Map<string, { number: string; status: SystemEntryResult['status'] }>> {
    if (!ids.length) return new Map();
    try {
      return await this.ledger.entryStatuses(ids);
    } catch (e) {
      this.logger.warn(`Ledger entry statuses unavailable: ${(e as Error).message}`);
      return new Map();
    }
  }
}

function nextStep(r: PayrollRun): PayrollRunView['next'] {
  switch (r.stage) {
    case 'draft':
      return { action: 'calculate', label: 'Finance locks attendance and calculates the salaries' };
    case 'calculated':
      return { action: 'prepare', label: 'Finance prepares the draft and checks it' };
    case 'prepared':
      return { action: 'review', label: 'The Director reviews it' };
    case 'reviewed':
      return { action: 'approve', label: 'The CEO approves it (confirming their password again)' };
    default:
      return r.paymentEntryId ? { action: null, label: 'Approved and paid' } : { action: 'mark_paid', label: 'Finance records the bank transfer' };
  }
}

function lineView(
  l: PayrollLine & { employee: { empId: string; fullName: string } },
  empIdOf: Map<string, string>,
  items: Array<{ id: string; employeeId: string; kind: 'bonus' | 'deduction'; source: 'manual' | 'commission' | 'adjustment'; label: string; amount: Prisma.Decimal; createdAt: Date }>,
  lastMonthNet: string | null,
): PayrollLineView {
  return {
    id: l.id,
    empId: l.employee.empId,
    name: l.employee.fullName,
    base: money(l.baseSalary),
    allowances: money(l.allowances),
    bonus: money(l.bonus),
    unpaidDays: dec(l.unpaidDays).toFixed(1),
    unpaidDeduction: money(l.unpaidDeduction),
    gross: money(grossOf(l)),
    taxableIncome: money(l.taxableIncome),
    tax: money(l.tax),
    advanceDeduction: money(l.advanceDeduction),
    otherDeductions: money(l.otherDeductions),
    net: money(l.net),
    workingDays: l.workingDays,
    presentDays: l.presentDays,
    lateDays: l.lateDays,
    absentDays: l.absentDays,
    flags: (Array.isArray(l.flags) ? l.flags : []) as PayrollLineFlag[],
    items: items
      .filter((i) => i.employeeId === l.employeeId)
      .map((i) => ({ id: i.id, empId: empIdOf.get(i.employeeId) ?? '', kind: i.kind, source: i.source, label: i.label, amount: money(i.amount), createdAt: i.createdAt.toISOString() })),
    lastMonthNet,
  };
}

/** A CSV cell: quoted when needed; a leading formula character is neutralised (CSV injection). */
function csvCell(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

