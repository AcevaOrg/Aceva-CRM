import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_MODULES,
  activityEventsQuerySchema,
  checkAlertRequestSchema,
  exportLogRequestSchema,
  healthResponseSchema,
  heartbeatRequestSchema,
  logoutRequestSchema,
  outboxEventSchema,
  outboxEventSchemas,
  screenViewRequestSchema,
  summariesQuerySchema,
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
      'activity.alert.raised',
      'activity.flagged',
      'auth.login',
      'auth.login_failed',
      'auth.logout',
      'auth.security',
      'employee.offboarded',
      'payroll.final_settlement.requested',
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

describe('Module 4 event contracts', () => {
  it('a logout can end for every reason Module 4 understands, including from another device and after too many wrong codes', () => {
    const reasons = ['user', 'idle_timeout', 'max_duration', 'password_changed', 'forced', 'employee_left', 'user_other_device', 'too_many_wrong_codes'];
    for (const reason of reasons) {
      const event = { ...base, type: 'auth.logout', payload: { empId: 'ACV-0007', sessionId: base.id, reason } };
      expect(outboxEventSchema.safeParse(event).success).toBe(true);
    }
    expect(outboxEventSchema.safeParse({ ...base, type: 'auth.logout', payload: { empId: 'ACV-0007', sessionId: base.id, reason: 'shut_laptop' } }).success).toBe(false);
  });

  it('accepts a security event by an administrator and by the system', () => {
    const byAdmin = { ...base, type: 'auth.security', payload: { empId: 'ACV-0011', kind: 'account_locked', byEmpId: 'ACV-0003' } };
    const bySystem = { ...base, actor: 'system', type: 'auth.security', payload: { empId: 'ACV-0011', kind: 'account_locked', byEmpId: null } };
    expect(outboxEventSchema.safeParse(byAdmin).success).toBe(true);
    expect(outboxEventSchema.safeParse(bySystem).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...byAdmin, payload: { ...byAdmin.payload, kind: 'password_shown' } }).success).toBe(false);
  });

  it('accepts a flagged activity and a raised alert, never with internal UUIDs as Emp-IDs', () => {
    const flagged = { ...base, type: 'activity.flagged', payload: { eventId: base.id, empId: 'ACV-0008', kind: 'finance_blocked', at: base.occurredAt, module: 'Ledger', rows: null } };
    expect(outboxEventSchema.safeParse(flagged).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...flagged, payload: { ...flagged.payload, empId: base.id } }).success).toBe(false);
    const raised = { ...base, type: 'activity.alert.raised', payload: { alertId: base.id, kind: 'new_device', severity: 'medium', empId: 'ACV-0008' } };
    expect(outboxEventSchema.safeParse(raised).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...raised, payload: { ...raised.payload, severity: 'critical' } }).success).toBe(false);
  });
});

describe('Module 4 request contracts', () => {
  it('a logout without a body is a plain logout; the browser may say it timed out, and nothing else', () => {
    expect(logoutRequestSchema.parse(undefined)).toEqual({});
    expect(logoutRequestSchema.parse({})).toEqual({});
    expect(logoutRequestSchema.parse({ reason: 'idle_timeout', financeScreen: true })).toEqual({ reason: 'idle_timeout', financeScreen: true });
    expect(logoutRequestSchema.safeParse({ reason: 'forced' }).success).toBe(false);
    expect(logoutRequestSchema.safeParse({ reason: 'idle_timeout', extra: 1 }).success).toBe(false);
    expect(logoutRequestSchema.safeParse({ financeScreen: 'yes' }).success).toBe(false);
  });

  it('a heartbeat carries only a yes/no, nothing else (no keystrokes, no screen content)', () => {
    expect(heartbeatRequestSchema.safeParse({ active: true }).success).toBe(true);
    expect(heartbeatRequestSchema.safeParse({ active: 'yes' }).success).toBe(false);
    expect(heartbeatRequestSchema.safeParse({ active: true, keys: 'abc' }).success).toBe(false);
  });

  it('a screen view is a label and an optional page path', () => {
    expect(screenViewRequestSchema.safeParse({ screen: 'My tasks', path: '/tasks' }).success).toBe(true);
    expect(screenViewRequestSchema.safeParse({ screen: '' }).success).toBe(false);
    expect(screenViewRequestSchema.safeParse({ screen: 'Ledger', path: 'finance/ledger' }).success).toBe(false);
  });

  it('activity search treats empty filters as "any"', () => {
    const parsed = activityEventsQuerySchema.parse({ action: '', source: '', module: 'People', from: '2026-11-01', to: '2026-11-07' });
    expect(parsed).toEqual({ module: 'People', from: '2026-11-01', to: '2026-11-07' });
    expect(activityEventsQuerySchema.safeParse({ action: 'teleport' }).success).toBe(false);
    expect(activityEventsQuerySchema.safeParse({ empId: '42' }).success).toBe(false);
  });

  it('summaries need a date range that runs forwards', () => {
    expect(summariesQuerySchema.safeParse({ from: '2026-11-01', to: '2026-11-07', scope: 'team' }).success).toBe(true);
    expect(summariesQuerySchema.safeParse({ from: '2026-11-08', to: '2026-11-07' }).success).toBe(false);
  });

  it('checking an alert needs a note; an export log needs a row count and a format', () => {
    expect(checkAlertRequestSchema.safeParse({ note: 'Confirmed with the employee' }).success).toBe(true);
    expect(checkAlertRequestSchema.safeParse({ note: '  ' }).success).toBe(false);
    expect(exportLogRequestSchema.safeParse({ rows: 120, format: 'xlsx' }).success).toBe(true);
    expect(exportLogRequestSchema.safeParse({ rows: -1, format: 'xlsx' }).success).toBe(false);
    expect(exportLogRequestSchema.safeParse({ rows: 1, format: 'docx' }).success).toBe(false);
  });

  it('the activity search offers every module the server records, including Org (structure changes), and none twice', () => {
    expect(ACTIVITY_MODULES).toEqual(expect.arrayContaining(['Org', 'Home', 'Login', 'People', 'Ledger', 'Banking', 'Payroll', 'Statements', 'Sales', 'Announcements']));
    expect(new Set(ACTIVITY_MODULES).size).toBe(ACTIVITY_MODULES.length);
    // Every label is a valid search filter
    for (const module of ACTIVITY_MODULES) expect(activityEventsQuerySchema.safeParse({ module }).success).toBe(true);
  });
});
