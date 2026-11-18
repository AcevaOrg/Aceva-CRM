import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_MODULES,
  activityEventsQuerySchema,
  addCommentRequestSchema,
  approveTaskRequestSchema,
  checkAlertRequestSchema,
  createTaskRequestSchema,
  decideApprovalRequestSchema,
  exportLogRequestSchema,
  healthResponseSchema,
  heartbeatRequestSchema,
  logoutRequestSchema,
  outboxEventSchema,
  outboxEventSchemas,
  reasonActionRequestSchema,
  repeatRuleSchema,
  requestExtensionRequestSchema,
  screenViewRequestSchema,
  summariesQuerySchema,
  taskListQuerySchema,
  updateSizeRuleRequestSchema,
  updateTaskRequestSchema,
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
      'task.approved',
      'task.comment_added',
      'task.created',
      'task.deadline_changed',
      'task.extension_decided',
      'task.extension_requested',
      'task.reminder.due',
      'task.reworked',
      'task.status_changed',
      'task.transferred',
      'task.transfer.requested',
    ].sort());
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

describe('Module 5 task contracts', () => {
  const task = '7d3f1c9a-2b4e-4a6d-8c1f-0e5a9b7c3d21';
  const create = { title: 'Fix login bug', assignee: 'ACV-0007', size: 'M', estimatedHours: 16, startDate: '2026-11-16T04:00:00.000Z', deadline: '2026-11-19T13:00:00.000Z' };

  it('creating a task needs a title, an assignee below you, a size, hours and a deadline; defaults are filled in', () => {
    const parsed = createTaskRequestSchema.parse(create);
    expect(parsed).toMatchObject({ priority: 'medium', description: '', checklist: [] });
    expect(createTaskRequestSchema.safeParse({ ...create, assignee: undefined }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, assignee: '7' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, size: 'XXL' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, deadline: '2026-11-15T13:00:00.000Z' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, deadline: 'next week' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, estimatedHours: 0 }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, surprise: 1 }).success).toBe(false);
  });

  it('refuses dates outside the years 2020 to 2100 (a far-off deadline such as 9999-12-31 is never a plan)', () => {
    for (const deadline of ['9999-12-31T00:00:00.000Z', '2101-01-01T00:00:00.000Z', '1999-12-31T23:59:59.000Z']) {
      expect(createTaskRequestSchema.safeParse({ ...create, startDate: '2026-11-16T04:00:00.000Z', deadline }).success).toBe(false);
      expect(updateTaskRequestSchema.safeParse({ deadline, reason: 'Client moved the date' }).success).toBe(false);
      expect(requestExtensionRequestSchema.safeParse({ requestedDeadline: deadline, reason: 'Waiting for the API keys' }).success).toBe(false);
    }
    expect(createTaskRequestSchema.safeParse({ ...create, startDate: '1970-01-01T00:00:00.000Z' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, deadline: '2100-12-31T23:59:59.000Z' }).success).toBe(true);
    expect(updateTaskRequestSchema.safeParse({ deadline: '2100-12-31T23:59:59.000Z', reason: 'Client moved the date' }).success).toBe(true);
  });

  it('a personal to-do has no assignee and never repeats', () => {
    const todo = { ...create, assignee: '', personal: true };
    expect(createTaskRequestSchema.safeParse(todo).success).toBe(true);
    expect(createTaskRequestSchema.safeParse({ ...todo, assignee: 'ACV-0007' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...todo, repeat: { every: 'week', on: 1 } }).success).toBe(false);
  });

  it('a repeat rule is weekly on a weekday 1 to 7 or monthly on a day 1 to 28, with an optional stop date', () => {
    expect(repeatRuleSchema.safeParse({ every: 'week', on: 1 }).success).toBe(true);
    expect(repeatRuleSchema.safeParse({ every: 'week', on: 1, until: '2027-03-01' }).success).toBe(true);
    expect(repeatRuleSchema.safeParse({ every: 'week', on: 8 }).success).toBe(false);
    expect(repeatRuleSchema.safeParse({ every: 'month', on: 28 }).success).toBe(true);
    expect(repeatRuleSchema.safeParse({ every: 'month', on: 29 }).success).toBe(false);
    expect(repeatRuleSchema.safeParse({ every: 'year', on: 1 }).success).toBe(false);
  });

  it('an empty edit is refused; the reason for a deadline change is checked by the server (a personal to-do needs none)', () => {
    expect(updateTaskRequestSchema.safeParse({ deadline: '2026-11-20T13:00:00.000Z', reason: 'Client moved the date' }).success).toBe(true);
    expect(updateTaskRequestSchema.safeParse({ deadline: '2026-11-20T13:00:00.000Z' }).success).toBe(true);
    expect(updateTaskRequestSchema.safeParse({ reason: 'Because' }).success).toBe(false);
    expect(updateTaskRequestSchema.safeParse({ title: 'New title' }).success).toBe(true);
  });

  it('approve needs a rating from 1 to 5; rework, hold and cancel need a reason', () => {
    expect(approveTaskRequestSchema.safeParse({ rating: 5, comment: 'Great' }).success).toBe(true);
    expect(approveTaskRequestSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(approveTaskRequestSchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(approveTaskRequestSchema.safeParse({ rating: 3.5 }).success).toBe(false);
    expect(approveTaskRequestSchema.safeParse({}).success).toBe(false);
    expect(reasonActionRequestSchema.safeParse({ reason: 'Tests are missing' }).success).toBe(true);
    expect(reasonActionRequestSchema.safeParse({ reason: '  ' }).success).toBe(false);
    expect(reasonActionRequestSchema.safeParse({}).success).toBe(false);
  });

  it('an extension asks for a new date and says why; a comment cannot be empty', () => {
    expect(requestExtensionRequestSchema.safeParse({ requestedDeadline: '2026-11-25T13:00:00.000Z', reason: 'Waiting for the API keys' }).success).toBe(true);
    expect(requestExtensionRequestSchema.safeParse({ requestedDeadline: '2026-11-25T13:00:00.000Z' }).success).toBe(false);
    expect(addCommentRequestSchema.safeParse({ body: 'Thanks @Mariam' }).success).toBe(true);
    expect(addCommentRequestSchema.safeParse({ body: '   ' }).success).toBe(false);
  });

  it('the task list treats empty filters as "any" and only knows the three scopes', () => {
    expect(taskListQuerySchema.parse({})).toEqual({ scope: 'mine' });
    expect(taskListQuerySchema.parse({ scope: 'team', status: '', assignee: 'ACV-0008', includePersonal: 'true' })).toEqual({ scope: 'team', assignee: 'ACV-0008', includePersonal: true });
    expect(taskListQuerySchema.safeParse({ scope: 'everyone' }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ status: 'late' }).success).toBe(false);
  });

  it('the task list can ask for open tasks only, or for the closed ones older than 90 days too', () => {
    expect(taskListQuerySchema.parse({ open: 'true', closed: 'all' })).toEqual({ scope: 'mine', open: true, closed: 'all' });
    expect(taskListQuerySchema.parse({ open: '', closed: '' })).toEqual({ scope: 'mine' });
    expect(taskListQuerySchema.parse({ closed: 'recent' })).toEqual({ scope: 'mine', closed: 'recent' });
    expect(taskListQuerySchema.safeParse({ closed: 'never' }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ open: 'maybe' }).success).toBe(false);
  });

  it('a size rule change needs a reason and at least one change', () => {
    expect(updateSizeRuleRequestSchema.safeParse({ hours: 20, reason: 'Our M tasks run longer' }).success).toBe(true);
    expect(updateSizeRuleRequestSchema.safeParse({ reason: 'Our M tasks run longer' }).success).toBe(false);
    expect(updateSizeRuleRequestSchema.safeParse({ hours: 20 }).success).toBe(false);
    expect(updateSizeRuleRequestSchema.safeParse({ points: -1, reason: 'Our M tasks run longer' }).success).toBe(false);
  });

  it('an approval decision may carry a rating, a reason and a comment, and nothing else', () => {
    expect(decideApprovalRequestSchema.parse(undefined)).toEqual({});
    expect(decideApprovalRequestSchema.safeParse({ rating: 4, comment: 'Good' }).success).toBe(true);
    expect(decideApprovalRequestSchema.safeParse({ rating: 9 }).success).toBe(false);
    expect(decideApprovalRequestSchema.safeParse({ secret: 1 }).success).toBe(false);
  });

  it('the task events accept Emp-IDs, never internal UUIDs, and carry what Module 6 needs', () => {
    const approved = {
      ...base,
      type: 'task.approved',
      payload: {
        taskId: task, number: 'TSK-0001', assignee: 'ACV-0007', reviewer: 'ACV-0004', rating: 4, size: 'M', points: 3, estimatedHours: 16,
        deadline: '2026-11-19T13:00:00.000Z', originalDeadline: '2026-11-18T13:00:00.000Z', startedAt: '2026-11-16T05:00:00.000Z', submittedAt: '2026-11-19T10:00:00.000Z',
        onTime: true, extensionsCount: 1, reworkCount: 0,
      },
    };
    expect(outboxEventSchema.safeParse(approved).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...approved, payload: { ...approved.payload, rating: 6 } }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...approved, payload: { ...approved.payload, assignee: task } }).success).toBe(false);
    const reworked = { ...base, type: 'task.reworked', payload: { taskId: task, number: 'TSK-0001', assignee: 'ACV-0007', reviewer: 'ACV-0004', reason: 'Tests missing', reworkCount: 1 } };
    expect(outboxEventSchema.safeParse(reworked).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...reworked, payload: { ...reworked.payload, reworkCount: 0 } }).success).toBe(false);
    const reminder = { ...base, actor: 'system', type: 'task.reminder.due', payload: { taskId: task, number: 'TSK-0001', kind: 'overdue', recipients: ['ACV-0007', 'ACV-0004'], deadline: '2026-11-19T13:00:00.000Z', day: '2026-11-20' } };
    expect(outboxEventSchema.safeParse(reminder).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...reminder, payload: { ...reminder.payload, recipients: [] } }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...reminder, payload: { ...reminder.payload, kind: 'whenever' } }).success).toBe(false);
  });
});
