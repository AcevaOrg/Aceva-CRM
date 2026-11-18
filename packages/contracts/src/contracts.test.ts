import { describe, expect, it } from 'vitest';
import {
  ESSENTIAL_NOTIFICATION_TYPES,
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
    const event = { ...base, type: 'sales.deal.won_confirmed', payload: { dealNumber: 'DEAL-2026-0001', ownerEmpId: 'ACV-0009', confirmedByEmpId: 'ACV-0003' } };
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
