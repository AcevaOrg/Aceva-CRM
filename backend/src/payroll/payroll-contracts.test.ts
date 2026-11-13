import { describe, expect, it } from 'vitest';
import {
  addPayrollItemSchema,
  createPayrollAdjustmentSchema,
  createPayrollRunSchema,
  createSalaryAdvanceSchema,
  createTaxSlabSetSchema,
  markPayrollPaidSchema,
  returnPayrollRunSchema,
  taxRateSchema,
} from '@aceva/contracts';

/** The shared Module 8 request schemas (packages/contracts/src/payroll.ts) accept good input and refuse bad input. */
const UUID = '6f1b6f5e-5a5d-4c8e-9a3a-2b1c0d9e8f7a';
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => schema.safeParse(v).success;

describe('M8 request contracts', () => {
  it('a run is for one month', () => {
    expect(ok(createPayrollRunSchema, { month: '2026-11' })).toBe(true);
    expect(ok(createPayrollRunSchema, { month: '2026-13' })).toBe(false);
    expect(ok(createPayrollRunSchema, { month: '11-2026' })).toBe(false);
  });

  it('an item has an Emp-ID, a kind, a label and a positive money string', () => {
    const base = { empId: 'ACV-0006', kind: 'bonus', label: 'Project bonus', amount: '5000.00' };
    expect(ok(addPayrollItemSchema, base)).toBe(true);
    expect(ok(addPayrollItemSchema, { ...base, kind: 'deduction', amount: '1' })).toBe(true);
    expect(ok(addPayrollItemSchema, { ...base, amount: 5000 })).toBe(false); // never a float
    expect(ok(addPayrollItemSchema, { ...base, amount: '0.00' })).toBe(false);
    expect(ok(addPayrollItemSchema, { ...base, amount: '10.005' })).toBe(false);
    expect(ok(addPayrollItemSchema, { ...base, kind: 'commission' })).toBe(false);
    expect(ok(addPayrollItemSchema, { ...base, empId: 'u-123' })).toBe(false);
    expect(ok(addPayrollItemSchema, { ...base, label: ' ' })).toBe(false);
  });

  it('sending back needs a reason; marking paid needs a bank account and a day', () => {
    expect(ok(returnPayrollRunSchema, { reason: 'Check the bonus lines' })).toBe(true);
    expect(ok(returnPayrollRunSchema, { reason: 'no' })).toBe(false);
    expect(ok(markPayrollPaidSchema, { bankAccountId: UUID, paidOn: '2026-11-05' })).toBe(true);
    expect(ok(markPayrollPaidSchema, { bankAccountId: 'bank', paidOn: '2026-11-05' })).toBe(false);
    expect(ok(markPayrollPaidSchema, { bankAccountId: UUID, paidOn: '2026-11-31' })).toBe(false);
  });

  it('an adjustment names the approved run, a later month and a reason', () => {
    const base = { empId: 'ACV-0007', originRunId: UUID, targetMonth: '2026-12', kind: 'deduction', amount: '250.50', reason: 'Overpaid allowance' };
    expect(ok(createPayrollAdjustmentSchema, base)).toBe(true);
    expect(ok(createPayrollAdjustmentSchema, { ...base, originRunId: undefined })).toBe(false);
    expect(ok(createPayrollAdjustmentSchema, { ...base, amount: '-1' })).toBe(false);
    expect(ok(createPayrollAdjustmentSchema, { ...base, reason: '' })).toBe(false);
  });

  it('an advance repays at most its amount per month', () => {
    const base = { empId: 'ACV-0007', amount: '6000', monthlyDeduction: '2000', startMonth: '2026-12', reason: 'Medical emergency', bankAccountId: UUID };
    expect(ok(createSalaryAdvanceSchema, base)).toBe(true);
    expect(ok(createSalaryAdvanceSchema, { ...base, monthlyDeduction: '6000' })).toBe(true);
    expect(ok(createSalaryAdvanceSchema, { ...base, monthlyDeduction: '6000.01' })).toBe(false);
    expect(ok(createSalaryAdvanceSchema, { ...base, bankAccountId: undefined })).toBe(false);
  });

  it('tax rates are between 0 and 1 with up to 4 decimals', () => {
    for (const v of ['0', '0.1', '0.11', '0.3500', '1', '1.0000']) expect(ok(taxRateSchema, v)).toBe(true);
    for (const v of ['1.01', '-0.1', '0.12345', '11', '35%']) expect(ok(taxRateSchema, v)).toBe(false);
  });

  it('a slab version starts at 0, has no gaps or overlaps, increases, and ends without an upper limit', () => {
    const slabs = [
      { from: '0', to: '600000', fixed: '0', rate: '0' },
      { from: '600000', to: '1200000', fixed: '0', rate: '0.01' },
      { from: '1200000', to: null, fixed: '6000', rate: '0.11' },
    ];
    const base = { effectiveFrom: '2026-07-01', label: 'FY 2026-27', slabs };
    expect(ok(createTaxSlabSetSchema, base)).toBe(true);
    expect(ok(createTaxSlabSetSchema, { ...base, slabs: [] })).toBe(false);
    expect(ok(createTaxSlabSetSchema, { ...base, slabs: [{ ...slabs[0], from: '1' }, ...slabs.slice(1)] })).toBe(false); // not from 0
    expect(ok(createTaxSlabSetSchema, { ...base, slabs: [slabs[0], { ...slabs[1], from: '650000' }, slabs[2]] })).toBe(false); // gap
    expect(ok(createTaxSlabSetSchema, { ...base, slabs: [slabs[0], { ...slabs[1], from: '500000' }, slabs[2]] })).toBe(false); // overlap
    expect(ok(createTaxSlabSetSchema, { ...base, slabs: slabs.slice(0, 2) })).toBe(false); // last slab has an upper limit
    expect(ok(createTaxSlabSetSchema, { ...base, slabs: [{ ...slabs[0], to: null }, ...slabs.slice(1)] })).toBe(false); // open slab in the middle
    expect(ok(createTaxSlabSetSchema, { ...base, slabs: [slabs[0], { ...slabs[1], to: '600000' }, { ...slabs[2], from: '600000' }] })).toBe(false); // empty slab
    expect(ok(createTaxSlabSetSchema, { ...base, slabs: [slabs[0], slabs[1], { ...slabs[2], fixed: '0', rate: '0.11' }] })).toBe(true);
    expect(ok(createTaxSlabSetSchema, { ...base, slabs: [slabs[0], { ...slabs[1], fixed: '100' }, { ...slabs[2], fixed: '50' }] })).toBe(false); // fixed goes down
    expect(ok(createTaxSlabSetSchema, { ...base, effectiveFrom: '2026-7-1' })).toBe(false);
  });
});
