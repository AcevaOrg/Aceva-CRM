import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { AttendancePayrollPort, type AttendanceMonthSummary } from '../src/attendance/attendance-payroll.port';
import { CryptoService } from '../src/auth/crypto.service';
import { dec, ZERO, type Decimal } from '../src/common/money';
import { LedgerPostingPort, type SystemEntryInput, type SystemEntryResult } from '../src/finance/ledger-posting.port';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client';
import type { TestApp } from './helpers/app';

/**
 * Module 8 test support (Track B). FAKE ports for Module 7 and Module 9, used only by the m8 tests while (or instead of)
 * the real implementations, plus small data helpers. Never imported by production code.
 */

export class FakeAttendance extends AttendancePayrollPort {
  workingDaysValue = 22;
  /** month -> empId -> unpaid leave days */
  unpaid: Record<string, Record<string, string>> = {};
  locked = new Set<string>();
  lockCalls: Array<{ month: string; actorId: string }> = [];

  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async workingDays(): Promise<number> {
    return this.workingDaysValue;
  }

  async isMonthLocked(month: string): Promise<boolean> {
    return this.locked.has(month);
  }

  async lockMonth(month: string, actorId: string): Promise<void> {
    this.locked.add(month);
    this.lockCalls.push({ month, actorId });
  }

  async monthSummary(month: string, employeeIds: string[], tx?: Prisma.TransactionClient): Promise<AttendanceMonthSummary[]> {
    const db = tx ?? this.prisma;
    const people = await db.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, empId: true } });
    return people.map((p) => ({
      employeeId: p.id,
      empId: p.empId,
      workingDays: this.workingDaysValue,
      presentDays: this.workingDaysValue,
      lateDays: 0,
      absentDays: 0,
      missedCheckouts: 0,
      paidLeaveDays: ZERO,
      unpaidLeaveDays: dec(this.unpaid[month]?.[p.empId] ?? '0'),
    }));
  }
}

export interface FakeEntry extends SystemEntryResult {
  input: SystemEntryInput;
}

export class FakeLedger extends LedgerPostingPort {
  readonly bank = { id: randomUUID(), code: '1100', name: 'Bank: PKR current account (fake)' };
  readonly entries = new Map<string, FakeEntry>();
  private counter = 0;

  async createSystemEntry(_tx: Prisma.TransactionClient, input: SystemEntryInput): Promise<SystemEntryResult> {
    const existing = [...this.entries.values()].find((e) => e.input.source === input.source && e.input.sourceRef === input.sourceRef && e.input.purpose === input.purpose);
    if (existing) return { id: existing.id, number: existing.number, status: existing.status };
    const debit = input.lines.reduce((a, l) => a.plus(l.debit ?? 0), dec(0));
    const credit = input.lines.reduce((a, l) => a.plus(l.credit ?? 0), dec(0));
    if (!debit.eq(credit) || debit.lte(0)) throw new BadRequestException({ statusCode: 400, code: 'unbalanced_entry', message: 'Total debits must equal total credits' });
    this.counter++;
    const entry: FakeEntry = { id: randomUUID(), number: `JE-2026-${String(9000 + this.counter)}`, status: 'pending_approval', input };
    this.entries.set(entry.id, entry);
    return { id: entry.id, number: entry.number, status: entry.status };
  }

  async entryStatuses(ids: string[]): Promise<Map<string, { number: string; status: SystemEntryResult['status'] }>> {
    const out = new Map<string, { number: string; status: SystemEntryResult['status'] }>();
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) out.set(id, { number: e.number, status: e.status });
    }
    return out;
  }

  async findBankAccount(accountId: string): Promise<{ id: string; code: string; name: string } | null> {
    return accountId === this.bank.id ? this.bank : null;
  }

  bySource(source: SystemEntryInput['source'], sourceRef: string): FakeEntry[] {
    return [...this.entries.values()].filter((e) => e.input.source === source && e.input.sourceRef === sourceRef);
  }

  setStatus(id: string, status: SystemEntryResult['status']): void {
    this.entries.get(id)!.status = status;
  }
}

/** Lines of a fake entry as [side, role or account, amount] for easy comparison. */
export function entryRows(e: FakeEntry): Array<[string, string, string]> {
  return e.input.lines.map((l) => [l.debit ? 'Dr' : 'Cr', l.accountRole ?? l.accountId ?? '?', (l.debit ?? l.credit ?? ZERO).toFixed(2)]);
}

export const sumOf = (values: Array<Decimal | undefined>) => values.reduce<Decimal>((a, v) => a.plus(v ?? 0), dec(0));

/** Pay on file for an employee (amounts and an encrypted bank account), written directly for the test. */
export async function setPay(t: TestApp, prisma: PrismaClient, empId: string, pay: { base: string; allowances?: string; bank?: string; account?: string }): Promise<string> {
  const crypto = t.app.get(CryptoService);
  const person = await prisma.employee.findUniqueOrThrow({ where: { empId }, select: { id: true } });
  const account = pay.account ?? null;
  const data = {
    baseSalary: pay.base,
    allowances: pay.allowances ?? '0',
    bankName: pay.bank ?? 'HBL',
    bankAccountEncrypted: account ? crypto.encrypt(account) : null,
    bankAccountLast4: account ? account.slice(-4) : null,
  };
  await prisma.employeePay.upsert({ where: { employeeId: person.id }, update: data, create: { employeeId: person.id, ...data } });
  return person.id;
}

/** Example yearly slabs (test data only; the accountant enters the real ones). */
export const TEST_SLABS = {
  effectiveFrom: '2026-07-01',
  label: 'Salaried slabs FY 2026-27 (test data)',
  slabs: [
    { from: '0', to: '600000', fixed: '0', rate: '0' },
    { from: '600000', to: '1200000', fixed: '0', rate: '0.01' },
    { from: '1200000', to: '2200000', fixed: '6000', rate: '0.11' },
    { from: '2200000', to: '3200000', fixed: '116000', rate: '0.23' },
    { from: '3200000', to: '4100000', fixed: '346000', rate: '0.3' },
    { from: '4100000', to: null, fixed: '616000', rate: '0.35' },
  ],
};

export const API = '/api/v1';
