import { describe, expect, it } from 'vitest';
import { dec } from '../common/money';
import {
  advanceTakes,
  allocateAdvanceDeduction,
  calculateLine,
  grossOf,
  monthlyTax,
  runTotals,
  salaryEntryLines,
  slabsProblem,
  unpaidLeaveDeduction,
  yearlyTax,
  type LineInput,
  type TaxSlabRow,
} from './payroll-calc';

/** The example slabs used by the website mock (yearly PKR). Test data only: the accountant enters the real ones. */
const SLABS: TaxSlabRow[] = [
  { from: '0', to: '600000', fixed: '0', rate: '0' },
  { from: '600000', to: '1200000', fixed: '0', rate: '0.01' },
  { from: '1200000', to: '2200000', fixed: '6000', rate: '0.11' },
  { from: '2200000', to: '3200000', fixed: '116000', rate: '0.23' },
  { from: '3200000', to: '4100000', fixed: '346000', rate: '0.3' },
  { from: '4100000', to: null, fixed: '616000', rate: '0.35' },
];

const s = (d: { toFixed: (n: number) => string }) => d.toFixed(2);

describe('yearly and monthly income tax (slab with from < income <= to)', () => {
  it('uses the lower slab exactly at a boundary and the next one just above it', () => {
    expect(yearlyTax('600000', SLABS).toString()).toBe('0');
    expect(yearlyTax('600000.12', SLABS).toString()).toBe('0.0012');
    expect(yearlyTax('1200000', SLABS).toString()).toBe('6000');
    expect(yearlyTax('1200012', SLABS).toString()).toBe('6001.32');
    expect(yearlyTax('4100000', SLABS).toString()).toBe('616000');
    expect(yearlyTax('5000000', SLABS).toString()).toBe('931000');
  });

  it('charges nothing on zero or negative income', () => {
    expect(s(yearlyTax('0', SLABS))).toBe('0.00');
    expect(s(yearlyTax('-5', SLABS))).toBe('0.00');
    expect(s(monthlyTax('0', SLABS))).toBe('0.00');
  });

  it('monthly tax = yearly tax on (monthly x 12) / 12, rounded to paisa', () => {
    expect(s(monthlyTax('50000', SLABS))).toBe('0.00');
    expect(s(monthlyTax('50000.01', SLABS))).toBe('0.00'); // 0.0012 / 12
    expect(s(monthlyTax('100000', SLABS))).toBe('500.00');
    expect(s(monthlyTax('100001', SLABS))).toBe('500.11'); // 6001.32 / 12 = 500.11
    expect(s(monthlyTax('150000', SLABS))).toBe('6000.00');
    expect(s(monthlyTax('123456.78', SLABS))).toBe('3080.25'); // 36962.9496 / 12 = 3080.2458
  });

  it('rounds half up (0.005 becomes 0.01)', () => {
    expect(s(monthlyTax('50000.50', SLABS))).toBe('0.01'); // yearly 0.06, / 12 = 0.005
  });

  it('fails loudly when no slab covers the income (a bad slab list), instead of charging 0', () => {
    expect(() => yearlyTax('700000', [{ from: '0', to: '600000', fixed: '0', rate: '0' }])).toThrow();
  });
});

describe('unpaid leave deduction = base / working days x unpaid days', () => {
  it('works with half days and with 21 or 22 working days, rounded to paisa', () => {
    expect(s(unpaidLeaveDeduction('100000', 22, '1.5'))).toBe('6818.18');
    expect(s(unpaidLeaveDeduction('100000', 21, '1.5'))).toBe('7142.86');
    expect(s(unpaidLeaveDeduction('100000', 21, '1'))).toBe('4761.90');
    expect(s(unpaidLeaveDeduction('100000', 22, '0.5'))).toBe('2272.73');
    expect(s(unpaidLeaveDeduction('100000', 22, '22'))).toBe('100000.00');
  });

  it('rounds half up', () => {
    expect(s(unpaidLeaveDeduction('100.10', 20, '1'))).toBe('5.01'); // 5.005
  });

  it('deducts nothing without unpaid days or without working days', () => {
    expect(s(unpaidLeaveDeduction('100000', 22, '0'))).toBe('0.00');
    expect(s(unpaidLeaveDeduction('100000', 0, '2'))).toBe('0.00');
  });
});

describe('advances', () => {
  it('each active advance repays min(monthly deduction, remaining)', () => {
    const takes = advanceTakes([
      { id: 'a1', monthlyDeduction: '3000', remaining: '2000' },
      { id: 'a2', monthlyDeduction: '5000', remaining: '10000' },
      { id: 'a3', monthlyDeduction: '5000', remaining: '0' },
    ]);
    expect(takes.map((t) => [t.advanceId, s(t.amount)])).toEqual([
      ['a1', '2000.00'],
      ['a2', '5000.00'],
    ]);
  });

  it('splits a saved deduction at approval, and says when the advances no longer cover it', () => {
    const advances = [
      { id: 'a1', monthlyDeduction: '3000', remaining: '2000' },
      { id: 'a2', monthlyDeduction: '5000', remaining: '10000' },
    ];
    expect(allocateAdvanceDeduction('7000', advances)!.map((t) => s(t.amount))).toEqual(['2000.00', '5000.00']);
    expect(allocateAdvanceDeduction('0', advances)).toEqual([]);
    expect(allocateAdvanceDeduction('7000', advances.slice(0, 1))).toBeNull();
  });
});

const line = (over: Partial<LineInput> = {}): LineInput => ({
  base: '100000',
  allowances: '10000',
  bonuses: [],
  deductions: [],
  workingDays: 22,
  unpaidDays: '0',
  advances: [],
  ...over,
});

describe('one salary line', () => {
  it('gross, tax, advance and other deductions and net, exactly', () => {
    const r = calculateLine(
      line({
        bonuses: ['5000'],
        deductions: ['1000'],
        unpaidDays: '1.5',
        advances: [
          { id: 'a1', monthlyDeduction: '3000', remaining: '2000' },
          { id: 'a2', monthlyDeduction: '5000', remaining: '10000' },
        ],
      }),
      SLABS,
    );
    expect(s(r.unpaidDeduction)).toBe('6818.18');
    expect(s(r.bonus)).toBe('5000.00');
    expect(s(r.gross)).toBe('108181.82');
    expect(s(r.taxableIncome)).toBe('108181.82'); // D9: taxable = gross
    expect(s(r.tax)).toBe('1400.00'); // yearly 16800.0024 / 12
    expect(s(r.advanceDeduction)).toBe('7000.00');
    expect(s(r.otherDeductions)).toBe('1000.00');
    expect(s(r.net)).toBe('98781.82');
    expect(r.noWorkingDays).toBe(false);
  });

  it('sums several bonus and deduction items', () => {
    const r = calculateLine(line({ allowances: '0', bonuses: ['0.10', '0.20'], deductions: ['0.05', '0.05'] }), SLABS);
    expect(s(r.bonus)).toBe('0.30');
    expect(s(r.gross)).toBe('100000.30');
    expect(s(r.otherDeductions)).toBe('0.10');
  });

  it('flags a month without working days and deducts no unpaid leave', () => {
    const r = calculateLine(line({ workingDays: 0, unpaidDays: '3' }), SLABS);
    expect(r.noWorkingDays).toBe(true);
    expect(s(r.unpaidDeduction)).toBe('0.00');
    expect(s(r.gross)).toBe('110000.00');
  });

  it('gives a negative net when deductions exceed pay (the service refuses to save it)', () => {
    const r = calculateLine(line({ base: '10000', allowances: '0', deductions: ['20000'] }), SLABS);
    expect(r.net.isNegative()).toBe(true);
  });

  it('never uses floating point: 0.1 + 0.2 is exactly 0.30', () => {
    const r = calculateLine(line({ base: '0.1', allowances: '0.2', workingDays: 21 }), SLABS);
    expect(r.gross.toString()).toBe('0.3');
    expect(s(r.net)).toBe('0.30');
  });
});

describe('run totals and the salary journal entry', () => {
  const lines = [
    { baseSalary: '100000', allowances: '10000', bonus: '5000', unpaidDeduction: '6818.18', tax: '1400', advanceDeduction: '7000', otherDeductions: '1000', net: '98781.82' },
    { baseSalary: '60000', allowances: '0', bonus: '0', unpaidDeduction: '0', tax: '0', advanceDeduction: '0', otherDeductions: '0', net: '60000' },
  ];

  it('adds up exactly', () => {
    const t = runTotals(lines);
    expect(s(grossOf(lines[0]))).toBe('108181.82');
    expect([t.gross, t.tax, t.advanceDeductions, t.otherDeductions, t.net].map(s)).toEqual(['168181.82', '1400.00', '7000.00', '1000.00', '158781.82']);
  });

  it('Dr salary expense = Cr tax + advances + other deductions + salary payable, zero lines left out', () => {
    const entry = salaryEntryLines(runTotals(lines));
    const debit = entry.filter((l) => l.side === 'debit').reduce((a, l) => a.plus(l.amount), dec(0));
    const credit = entry.filter((l) => l.side === 'credit').reduce((a, l) => a.plus(l.amount), dec(0));
    expect(s(debit)).toBe(s(credit));
    expect(entry.map((l) => [l.side, l.role, s(l.amount)])).toEqual([
      ['debit', 'salary_expense', '168181.82'],
      ['credit', 'tax_payable', '1400.00'],
      ['credit', 'employee_advances', '7000.00'],
      ['credit', 'payroll_deductions', '1000.00'],
      ['credit', 'salary_payable', '158781.82'],
    ]);
    expect(salaryEntryLines(runTotals([lines[1]])).map((l) => l.role)).toEqual(['salary_expense', 'salary_payable']);
  });
});

describe('tax slab validation', () => {
  it('accepts a contiguous, increasing list that ends without an upper limit', () => {
    expect(slabsProblem(SLABS)).toBeNull();
  });
  it('refuses gaps, overlaps, a bad start, a closed last slab and rates outside 0..1', () => {
    expect(slabsProblem([])).not.toBeNull();
    expect(slabsProblem([{ from: '1', to: null, fixed: '0', rate: '0' }])).toMatch(/starts at 0/);
    expect(slabsProblem([{ from: '0', to: '100', fixed: '0', rate: '0' }, { from: '200', to: null, fixed: '0', rate: '0.1' }])).toMatch(/previous one ends/);
    expect(slabsProblem([{ from: '0', to: '100', fixed: '0', rate: '0' }])).toMatch(/last slab/);
    expect(slabsProblem([{ from: '0', to: null, fixed: '0', rate: '1.5' }])).toMatch(/rate/);
    expect(slabsProblem([{ from: '0', to: '0', fixed: '0', rate: '0' }, { from: '0', to: null, fixed: '0', rate: '0' }])).toMatch(/ends above/);
  });
});
