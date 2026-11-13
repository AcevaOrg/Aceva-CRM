import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dec } from '../src/common/money';
import type { PrismaClient } from '../src/generated/prisma/client';
import { LedgerPostingPort, type SystemEntryInput } from '../src/finance/ledger-posting.port';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/** The M9 -> M8 posting port: the guarantees in ledger-posting.port.ts, called the way Module 8 calls it. */
const FINANCE = 'ACV-0010';
const DIRECTOR = 'ACV-0003';

let t: TestApp;
let prisma: PrismaClient;
let port: LedgerPostingPort;
let db: PrismaService;
let financeId = '';
let directorId = '';

const codeOf = (e: unknown) => (e instanceof HttpException ? (e.getResponse() as { code?: string }).code : String(e));

function salaryEntry(ref: string, amount: string, overrides: Partial<SystemEntryInput> = {}): SystemEntryInput {
  return {
    source: 'payroll',
    sourceRef: ref,
    purpose: 'salary',
    entryDate: '2026-10-31',
    description: `Salaries ${ref}`,
    makerId: financeId,
    lines: [
      { accountRole: 'salary_expense', debit: dec(amount), description: 'Gross pay' },
      { accountRole: 'salary_payable', credit: dec(amount).minus(1000), description: 'Net pay' },
      { accountRole: 'tax_payable', credit: dec(1000), description: 'Income tax withheld' },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  t = await createTestApp();
  await t.ensureFixtures();
  prisma = createTestPrisma();
  port = t.app.get(LedgerPostingPort);
  db = t.app.get(PrismaService);
  financeId = (await prisma.employee.findUniqueOrThrow({ where: { empId: FINANCE } })).id;
  directorId = (await prisma.employee.findUniqueOrThrow({ where: { empId: DIRECTOR } })).id;
}, 120000);
afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M9 LedgerPostingPort (used by Module 8)', () => {
  it('creates the entry as a draft with its lines and submits it: it waits for approval at the tier its amount needs', async () => {
    const result = await db.$transaction((tx) => port.createSystemEntry(tx, salaryEntry('run-1', '40000.10')));
    expect(result.status).toBe('pending_approval');
    expect(result.number).toMatch(/^JE-\d{4}-\d{4}$/);
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: result.id }, include: { lines: { orderBy: { lineNo: 'asc' }, include: { account: true } }, events: true } });
    expect(entry.source).toBe('payroll');
    expect(entry.makerId).toBe(financeId);
    expect(entry.requiredLevel).toBe(3); // Director tier (finance officer is level 4)
    expect(entry.totalBase.toFixed(2)).toBe('40000.10');
    expect(entry.lines.map((l) => l.account.systemRole)).toEqual(['salary_expense', 'salary_payable', 'tax_payable']);
    expect(entry.lines[1].credit.toFixed(2)).toBe('39000.10');
    expect(entry.events.map((e) => e.action).sort()).toEqual(['created', 'submitted']);
    expect(await prisma.auditLog.count({ where: { action: 'finance.entry.submitted', targetId: result.number } })).toBe(1);
  });

  it('is idempotent on (source, sourceRef, purpose): a second call returns the existing entry', async () => {
    const first = await db.$transaction((tx) => port.createSystemEntry(tx, salaryEntry('run-2', '1500.00')));
    const again = await db.$transaction((tx) => port.createSystemEntry(tx, salaryEntry('run-2', '9999.00')));
    expect(again.id).toBe(first.id);
    expect(await prisma.journalEntry.count({ where: { source: 'payroll', sourceRef: 'run-2', purpose: 'salary' } })).toBe(1);
    const other = await db.$transaction((tx) => port.createSystemEntry(tx, salaryEntry('run-2', '1500.00', { purpose: 'payment' })));
    expect(other.id).not.toBe(first.id);
  });

  it('refuses an unbalanced entry and saves nothing', async () => {
    const input = salaryEntry('run-3', '5000.00');
    input.lines[2] = { accountRole: 'tax_payable', credit: dec('999.99') };
    const error = await db.$transaction((tx) => port.createSystemEntry(tx, input)).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('unbalanced_entry');
    expect(await prisma.journalEntry.count({ where: { sourceRef: 'run-3' } })).toBe(0);
  });

  it('refuses with account_role_missing when no account carries the role', async () => {
    const account = await prisma.ledgerAccount.findUniqueOrThrow({ where: { systemRole: 'payroll_deductions' } });
    await prisma.ledgerAccount.update({ where: { id: account.id }, data: { systemRole: null } });
    try {
      const input = salaryEntry('run-4', '5000.00');
      input.lines = [
        { accountRole: 'salary_expense', debit: dec(5000) },
        { accountRole: 'payroll_deductions', credit: dec(5000) },
      ];
      const error = await db.$transaction((tx) => port.createSystemEntry(tx, input)).catch((e: unknown) => e);
      expect(codeOf(error)).toBe('account_role_missing');
      expect((error as HttpException).getStatus()).toBe(409);
    } finally {
      await prisma.ledgerAccount.update({ where: { id: account.id }, data: { systemRole: 'payroll_deductions' } });
    }
  });

  it('refuses a date in a closed month (period_closed)', async () => {
    // closing (and reopening) directly in the database needs the matching workflow event in the same transaction
    const someone = (await prisma.employee.findFirstOrThrow({ where: { empId: 'ACV-0001' } })).id;
    await expect(prisma.financePeriod.create({ data: { month: '2026-03', status: 'closed' } })).rejects.toThrow(/approval workflow/);
    await prisma.$transaction([
      prisma.financePeriod.create({ data: { month: '2026-03', status: 'closed' } }),
      prisma.financePeriodEvent.create({ data: { month: '2026-03', action: 'close_approved', actorId: someone } }),
    ]);
    try {
      const error = await db.$transaction((tx) => port.createSystemEntry(tx, salaryEntry('run-5', '5000.00', { entryDate: '2026-03-31' }))).catch((e: unknown) => e);
      expect(codeOf(error)).toBe('period_closed');
    } finally {
      await expect(prisma.financePeriod.update({ where: { month: '2026-03' }, data: { status: 'open' } })).rejects.toThrow(/approval workflow/);
      await prisma.$transaction([
        prisma.financePeriod.update({ where: { month: '2026-03' }, data: { status: 'open' } }),
        prisma.financePeriodEvent.create({ data: { month: '2026-03', action: 'reopened', actorId: someone, reason: 'Test clean-up' } }),
      ]);
    }
  });

  it("runs inside the caller's transaction: if the caller fails, the entry is not saved either", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await port.createSystemEntry(tx, salaryEntry('run-6', '2000.00'));
        throw new Error('payroll step failed');
      }),
    ).rejects.toThrow('payroll step failed');
    expect(await prisma.journalEntry.count({ where: { sourceRef: 'run-6' } })).toBe(0);
  });

  it('an entry made by the Director goes one level up, to the CEO', async () => {
    const r = await db.$transaction((tx) => port.createSystemEntry(tx, salaryEntry('run-7', '30000.00', { makerId: directorId })));
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.id } })).requiredLevel).toBe(2);
  });

  it('a payment line can use a specific bank account; entryStatuses and findBankAccount answer for Module 8', async () => {
    const bank = await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: '1100' } });
    const r = await db.$transaction((tx) =>
      port.createSystemEntry(tx, {
        source: 'payroll_payment',
        sourceRef: 'run-1',
        purpose: 'payment',
        entryDate: '2026-11-01',
        description: 'Salary payment',
        makerId: financeId,
        lines: [
          { accountRole: 'salary_payable', debit: dec('39000.10') },
          { accountId: bank.id, credit: dec('39000.10') },
        ],
      }),
    );
    const statuses = await port.entryStatuses([r.id, 'not-a-uuid', '00000000-0000-4000-8000-000000000000']);
    expect(statuses.get(r.id)).toEqual({ number: r.number, status: 'pending_approval' });
    expect(statuses.size).toBe(1);
    expect(await port.findBankAccount(bank.id)).toEqual({ id: bank.id, code: '1100', name: bank.name });
    const expense = await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: '5200' } });
    expect(await port.findBankAccount(expense.id)).toBeNull();
    expect(await port.findBankAccount('garbage')).toBeNull();
  });
});
