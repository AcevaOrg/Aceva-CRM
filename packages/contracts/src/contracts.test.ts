import { describe, expect, it } from 'vitest';
import {
  BILLING_SETTINGS_DEFAULTS,
  billingSettingsSchema,
  containsCardNumber,
  createBillingInvoiceSchema,
  ESSENTIAL_NOTIFICATION_TYPES,
  recordInvoicePaymentSchema,
  resolveDealHandoverSchema,
  subscriptionCostSchema,
  healthResponseSchema,
  isEssentialNotificationType,
  markNotificationsReadSchema,
  notificationPrefsSchema,
  notificationSettingsSchema,
  notificationTypeSchema,
  outboxEventSchema,
  outboxEventSchemas,
  settingsModuleKeySchema,
  updateModuleSettingsSchema,
} from './index';

const base = {
  id: '3f2b8c1e-5a4d-4e6b-9c7a-1d2e3f4a5b6c',
  version: 1,
  occurredAt: '2026-11-10T10:00:00.000Z',
  actor: 'ACV-0003',
};

describe('health contract', () => {
  it('accepts a valid response and rejects an invalid one', () => {
    const ok = { status: 'ok', database: 'up', time: '2026-11-10T10:00:00.000Z', version: '0.1.0' };
    expect(healthResponseSchema.safeParse(ok).success).toBe(true);
    expect(healthResponseSchema.safeParse({ ...ok, database: 'maybe' }).success).toBe(false);
  });
});

describe('outbox event contracts', () => {
  it('defines exactly the agreed events, all at version 1', () => {
    expect(Object.keys(outboxEventSchemas).sort()).toEqual([
      'attendance.correction.decided',
      'auth.login',
      'auth.login_failed',
      'auth.logout',
      'billing.invoice.issued',
      'billing.invoice.overdue',
      'billing.invoice.paid',
      'billing.subscription.renewal_due',
      'comms.announcement.published',
      'comms.mention',
      'employee.offboarded',
      'finance.period.reopened',
      'leave.decided',
      'leave.requested',
      'ledger.entry.posted',
      'payroll.final_settlement.requested',
      'payroll.run.approved',
      'payroll.run.ready',
      'payslip.issued',
      'sales.commission.approved',
      'sales.deal.won_confirmed',
      'task.transfer.requested',
    ]);
    for (const versions of Object.values(outboxEventSchemas)) {
      expect(Object.keys(versions)).toEqual(['1']);
    }
  });

  it('accepts a valid employee.offboarded event', () => {
    const event = {
      ...base,
      type: 'employee.offboarded',
      payload: { empId: 'ACV-0007', lastWorkingDay: '2026-12-31', managerEmpId: 'ACV-0004' },
    };
    expect(outboxEventSchema.safeParse(event).success).toBe(true);
  });

  it('rejects a payload that does not match its event type', () => {
    const event = { ...base, type: 'auth.logout', payload: { empId: 'ACV-0007' } };
    expect(outboxEventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects an internal UUID where an Emp-ID is required', () => {
    const event = {
      ...base,
      type: 'task.transfer.requested',
      payload: { fromEmpId: base.id, toEmpId: 'ACV-0004', reason: 'employee_left' },
    };
    expect(outboxEventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects an unknown version', () => {
    const event = {
      ...base,
      version: 2,
      type: 'auth.logout',
      payload: { empId: 'ACV-0007', sessionId: base.id, reason: 'user' },
    };
    expect(outboxEventSchema.safeParse(event).success).toBe(false);
  });
});

describe('Cycle 3 foundation contracts', () => {
  it('accepts a sales.deal.won_confirmed event with Emp-IDs and refuses a missing deal number', () => {
    const event = {
      ...base,
      type: 'sales.deal.won_confirmed',
      payload: { dealNumber: 'DEAL-2026-0001', ownerEmpId: 'ACV-0009', confirmedByEmpId: 'ACV-0003', client: { partyId: null, name: 'Globex', email: null, country: null }, service: 'Website', value: '1500.00', currency: 'USD' },
    };
    expect(outboxEventSchema.safeParse(event).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...event, payload: { ...event.payload, dealNumber: '' } }).success).toBe(false);
  });

  it('notification types: the essential ones are part of the list, and a preference is a partial map', () => {
    for (const type of ESSENTIAL_NOTIFICATION_TYPES) expect(notificationTypeSchema.safeParse(type).success).toBe(true);
    expect(isEssentialNotificationType('security_alert')).toBe(true);
    expect(isEssentialNotificationType('payslip_available')).toBe(false);
    expect(notificationPrefsSchema.safeParse({ email: { payslip_available: false }, dailySummary: true }).success).toBe(true);
    expect(notificationPrefsSchema.safeParse({ email: { not_a_type: false }, dailySummary: true }).success).toBe(false);
    expect(markNotificationsReadSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(markNotificationsReadSchema.safeParse({}).success).toBe(true);
  });

  it('module settings: a key is lower case, a change carries a version and a reason', () => {
    expect(settingsModuleKeySchema.safeParse('notifications').success).toBe(true);
    expect(settingsModuleKeySchema.safeParse('Notifications').success).toBe(false);
    expect(updateModuleSettingsSchema.safeParse({ value: { emailEnabled: false }, version: 0, reason: 'Mail server is down' }).success).toBe(true);
    expect(updateModuleSettingsSchema.safeParse({ value: { emailEnabled: false }, version: 0, reason: 'x' }).success).toBe(false);
    expect(notificationSettingsSchema.safeParse({ emailEnabled: 'yes' }).success).toBe(false);
  });
});

describe('Module 13 billing contracts', () => {
  const uuid = '7d4f3a62-8f0e-4b8e-9a43-0c7a6c2c9a11';
  it('a recurring invoice needs a billing period; a one-time invoice has none', () => {
    const base = { requestKey: uuid, partyId: uuid, issueDate: '2026-11-18', termsDays: 14, lines: [{ description: 'Build', quantity: '1', unitPrice: '100.00' }] };
    expect(createBillingInvoiceSchema.safeParse(base).success).toBe(true);
    expect(createBillingInvoiceSchema.safeParse({ ...base, kind: 'recurring' }).success).toBe(false);
    expect(createBillingInvoiceSchema.safeParse({ ...base, kind: 'recurring', period: 'monthly' }).success).toBe(true);
    expect(createBillingInvoiceSchema.safeParse({ ...base, period: 'monthly' }).success).toBe(false);
  });

  it('a payment reference that contains a card number is refused; other references pass', () => {
    expect(containsCardNumber('Card 4111 1111 1111 1111')).toBe(true);
    expect(containsCardNumber('TT-778899 / 2026-11-18')).toBe(false);
    const p = { requestKey: uuid, bankAccountId: uuid, date: '2026-11-18', amount: '10.00', method: 'card_provider' };
    expect(recordInvoicePaymentSchema.safeParse({ ...p, reference: 'pi_3PqXyz' }).success).toBe(true);
    expect(recordInvoicePaymentSchema.safeParse({ ...p, reference: '4111-1111-1111-1111' }).success).toBe(false);
  });

  it('customer emails cannot be switched on without the sending address and the legal name; the defaults invent nothing', () => {
    expect(billingSettingsSchema.safeParse(BILLING_SETTINGS_DEFAULTS).success).toBe(true);
    expect(BILLING_SETTINGS_DEFAULTS.company.legalName).toBeNull();
    expect(BILLING_SETTINGS_DEFAULTS.customerEmails).toEqual({ enabled: false, fromAddress: null, replyTo: null });
    expect(BILLING_SETTINGS_DEFAULTS.reminderOffsets).toEqual([-3, 0, 3, 7]);
    const on = { ...BILLING_SETTINGS_DEFAULTS, customerEmails: { enabled: true, fromAddress: null, replyTo: null } };
    expect(billingSettingsSchema.safeParse(on).success).toBe(false);
    expect(billingSettingsSchema.safeParse({ ...on, customerEmails: { enabled: true, fromAddress: 'billing@company.test', replyTo: null }, company: { ...on.company, legalName: 'Company Ltd' } }).success).toBe(true);
  });

  it('a Won-deal handover is resolved by choosing exactly one client (no other fields)', () => {
    expect(resolveDealHandoverSchema.safeParse({ partyId: uuid }).success).toBe(true);
    expect(resolveDealHandoverSchema.safeParse({}).success).toBe(false);
    expect(resolveDealHandoverSchema.safeParse({ partyId: uuid, createClient: true }).success).toBe(false);
  });

  it('the default terms and income account are configurable development defaults (not fixed in code)', () => {
    expect(billingSettingsSchema.safeParse({ ...BILLING_SETTINGS_DEFAULTS, defaultTermsDays: 30, defaultIncomeAccountCode: '4200' }).success).toBe(true);
    expect(billingSettingsSchema.safeParse({ ...BILLING_SETTINGS_DEFAULTS, defaultIncomeAccountCode: null }).success).toBe(true);
  });

  it('an actual subscription cost needs a bill or the provider invoice reference', () => {
    expect(subscriptionCostSchema.safeParse({ amount: '10.00', currency: 'USD', estimated: true }).success).toBe(true);
    expect(subscriptionCostSchema.safeParse({ amount: '10.00', currency: 'USD', estimated: false }).success).toBe(false);
    expect(subscriptionCostSchema.safeParse({ amount: '10.00', currency: 'USD', estimated: false, reference: 'INV-77' }).success).toBe(true);
  });
});
