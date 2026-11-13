import type { Prisma } from '../src/generated/prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * DEVELOPMENT DEFAULTS for Modules 7, 8 and 9 (development and test databases only; seedDatabase refuses production).
 * None of these are company policy. They make the system usable before management and the accountant give the real
 * values (docs/M7-M9-DECISIONS.md lists each one):
 *   - working hours 09:00 to 18:00, Monday to Friday, 15 minutes grace (the plan's own example grace period);
 *   - leave types casual 10, sick 8, annual 14 days, unpaid without limit (the frontend demo values);
 *   - approval limits: the plan's EXAMPLE table (Director up to PKR 50,000, CEO up to PKR 500,000, Owner above);
 *   - finance year from July (Pakistan's normal tax year, plan section 14), confirm-again above PKR 50,000;
 *   - a DEVELOPMENT chart of accounts in the plan's five groups, to be replaced by the accountant's chart.
 * Tax slabs are NOT seeded: the accountant enters them (plan section 12).
 * Safe to run again: existing rows are left as they are.
 */
export const DEV_CHART: Array<{
  code: string;
  name: string;
  group: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  currency?: 'PKR' | 'USD';
  isBank?: boolean;
  requiresOwnerApproval?: boolean;
  systemRole?: string;
}> = [
  { code: '1100', name: 'Bank: PKR current account (development)', group: 'asset', isBank: true },
  { code: '1110', name: 'Bank: USD account (development)', group: 'asset', isBank: true, currency: 'USD' },
  { code: '1200', name: 'Accounts receivable', group: 'asset', systemRole: 'accounts_receivable' },
  { code: '1300', name: 'Employee advances', group: 'asset', systemRole: 'employee_advances' },
  { code: '2100', name: 'Accounts payable', group: 'liability', systemRole: 'accounts_payable' },
  { code: '2200', name: 'Salary payable', group: 'liability', systemRole: 'salary_payable' },
  { code: '2300', name: 'Income tax payable', group: 'liability', systemRole: 'tax_payable' },
  { code: '2400', name: 'Other payroll deductions (accountant to confirm)', group: 'liability', systemRole: 'payroll_deductions' },
  { code: '2500', name: 'Loans', group: 'liability', requiresOwnerApproval: true },
  { code: '3100', name: 'Share capital', group: 'equity', requiresOwnerApproval: true },
  { code: '3200', name: 'Owner capital', group: 'equity', requiresOwnerApproval: true },
  { code: '3300', name: 'Retained earnings', group: 'equity' },
  { code: '4100', name: 'Service income', group: 'income' },
  { code: '4900', name: 'Exchange gain or loss', group: 'income', systemRole: 'fx_gain_loss' },
  { code: '5100', name: 'Salary expense', group: 'expense', systemRole: 'salary_expense' },
  { code: '5200', name: 'Office expenses', group: 'expense' },
  { code: '5300', name: 'Software and subscriptions', group: 'expense' },
];

export async function seedCycle3Defaults(tx: Tx): Promise<void> {
  const note = 'Development default: management sets the real values (docs/M7-M9-DECISIONS.md)';

  if ((await tx.workSchedule.count()) === 0) {
    await tx.workSchedule.create({
      data: { effectiveFrom: new Date('2026-01-01'), startMinute: 9 * 60, endMinute: 18 * 60, graceMinutes: 15, workingWeekdays: [1, 2, 3, 4, 5], officeOnlyCheckIn: false, note },
    });
  }

  const leaveTypes = [
    { key: 'casual', name: 'Casual', yearlyDays: '10', paid: true, color: 'var(--chart-1)' },
    { key: 'sick', name: 'Sick', yearlyDays: '8', paid: true, color: 'var(--chart-3)' },
    { key: 'annual', name: 'Annual', yearlyDays: '14', paid: true, color: 'var(--chart-2)' },
    { key: 'unpaid', name: 'Unpaid', yearlyDays: null, paid: false, color: 'var(--chart-5)' },
  ];
  for (const t of leaveTypes) {
    await tx.leaveType.upsert({ where: { key: t.key }, update: {}, create: t });
  }

  const limits = [
    { approverLevel: 3, maxAmount: '50000', label: 'Director (plan example limit)' },
    { approverLevel: 2, maxAmount: '500000', label: 'CEO (plan example limit)' },
    { approverLevel: 1, maxAmount: null, label: 'Owner (above the CEO limit; all capital and loan entries)' },
  ];
  for (const l of limits) {
    await tx.approvalLimit.upsert({ where: { approverLevel: l.approverLevel }, update: {}, create: l });
  }

  await tx.financeSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1, stepUpAbove: '50000', financeYearStartMonth: 7 } });

  for (const a of DEV_CHART) {
    await tx.ledgerAccount.upsert({
      where: { code: a.code },
      update: {},
      create: {
        code: a.code,
        name: a.name,
        group: a.group,
        currency: a.currency ?? 'PKR',
        isBank: a.isBank ?? false,
        requiresOwnerApproval: a.requiresOwnerApproval ?? false,
        systemRole: a.systemRole ?? null,
      },
    });
  }
}
