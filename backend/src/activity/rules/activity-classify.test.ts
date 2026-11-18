import { describe, expect, it } from 'vitest';
import {
  changesData,
  classifyBlocked,
  classifyRequest,
  deviceFingerprint,
  deviceLabel,
  exportDataKind,
  financeScreenAccess,
  isFinanceApi,
  isRecordedElsewhere,
  loginFailedDescription,
  logoutDescription,
  logoutHow,
  moduleOf,
  securityDescription,
  targetOf,
  withoutPrefix,
} from './activity-classify';
import { changesFromAudit, fieldLabel } from './activity-changes';

describe('which module a request belongs to', () => {
  it('uses the names the screens use, longest path first', () => {
    expect(moduleOf('/api/v1/employees/:empId/basic')).toBe('People');
    expect(moduleOf('/api/v1/hire-requests/:id/approve')).toBe('People');
    expect(moduleOf('/api/v1/org/employees/:empId/level')).toBe('Org');
    expect(moduleOf('/api/v1/auth/employees/:empId/unlock')).toBe('Login');
    expect(moduleOf('/api/v1/finance/ledger/entries')).toBe('Ledger');
    expect(moduleOf('/api/v1/finance/statements/balance-sheet')).toBe('Statements');
    expect(moduleOf('/api/v1/finance/somewhere-new')).toBe('Finance');
    expect(moduleOf('/api/v1/tasks/:id/approve')).toBe('Tasks');
    expect(moduleOf('/api/v1/new-thing/:id')).toBe('New thing'); // a module not listed yet still gets a readable name
    expect(withoutPrefix('/api/v1')).toBe('/');
  });

  it('knows which areas hold finance data', () => {
    for (const path of ['/api/v1/finance/ledger', '/api/v1/payroll/runs/:id', '/api/v1/statements', '/api/v1/billing/invoices']) expect(isFinanceApi(path)).toBe(true);
    for (const path of ['/api/v1/employees/:empId/pay', '/api/v1/financeX', '/api/v1/tasks']) expect(isFinanceApi(path)).toBe(false);
    expect(exportDataKind('Ledger')).toBe('finance');
    expect(exportDataKind('Payroll')).toBe('finance');
    expect(exportDataKind('People')).toBe('employee');
    expect(exportDataKind('Activity')).toBe('employee');
    expect(exportDataKind('Tasks')).toBeNull();
  });
});

describe('finance screens on the website', () => {
  const perms = (...p: string[]) => new Set(p);

  it('a developer opening the ledger or the balance sheet is refused; their own payslip is fine', () => {
    const developer = perms('payroll.view_own', 'task.view_own');
    expect(financeScreenAccess('/finance/ledger', developer)).toEqual({ allowed: false });
    expect(financeScreenAccess('/finance/statements?tab=balance', developer)).toEqual({ allowed: false });
    expect(financeScreenAccess('/payroll', developer)).toEqual({ allowed: true });
    expect(financeScreenAccess('/billing/subscriptions', developer)).toEqual({ allowed: false });
  });

  it('the finance person and the Director open them; other pages are not finance screens', () => {
    expect(financeScreenAccess('/finance/ledger', perms('finance.view'))).toEqual({ allowed: true });
    expect(financeScreenAccess('/finance/close', perms('finance.view'))).toEqual({ allowed: false }); // needs finance.close
    expect(financeScreenAccess('/billing/subscriptions', perms('subscriptions.view'))).toEqual({ allowed: true });
    expect(financeScreenAccess('/tasks', perms())).toBeNull();
    expect(financeScreenAccess('/financial-news', perms())).toBeNull();
  });
});

describe('what a request records', () => {
  it('describes the known routes of Modules 1 to 4 in words', () => {
    expect(classifyRequest({ method: 'PATCH', route: '/api/v1/org/employees/:empId/level', params: { empId: 'ACV-0011' } })).toEqual({
      action: 'edit',
      module: 'Org',
      target: 'ACV-0011',
      description: 'Changed the level of ACV-0011',
      financeLinked: false,
    });
    expect(classifyRequest({ method: 'POST', route: '/api/v1/hire-requests/:id/approve', params: { id: 'f3b9' } })).toMatchObject({ action: 'approve', description: 'Approved a hire request' });
    expect(classifyRequest({ method: 'DELETE', route: '/api/v1/org/employees/:empId/duties/:dutyKey', params: { empId: 'ACV-0010', dutyKey: 'finance' } }).description).toBe(
      'Ended the finance duty of ACV-0010',
    );
    expect(classifyRequest({ method: 'POST', route: '/api/v1/auth/employees/:empId/unlock', params: { empId: 'ACV-0012' } })).toMatchObject({ action: 'security', module: 'Login' });
  });

  it('works out the action of a route nobody listed from its method and last word (future modules)', () => {
    const c = (method: string, route: string, params: Record<string, string> = {}) => classifyRequest({ method, route, params });
    expect(c('POST', '/api/v1/tasks').action).toBe('create');
    expect(c('PATCH', '/api/v1/tasks/:id', { id: 't1' })).toMatchObject({ action: 'edit', description: 'Changed t1 in Tasks' });
    expect(c('DELETE', '/api/v1/tasks/:id/comments/:commentId', { id: 't1' }).action).toBe('delete');
    expect(c('POST', '/api/v1/tasks/:id/approve', { id: 't1' }).action).toBe('approve');
    expect(c('POST', '/api/v1/tasks/:id/reject', { id: 't1' }).action).toBe('reject');
    expect(c('POST', '/api/v1/tasks/:id/submit', { id: 't1' }).action).toBe('submit');
    expect(c('POST', '/api/v1/tasks/:id/comments', { id: 't1' }).action).toBe('comment');
    expect(c('POST', '/api/v1/tasks/:id/attachments', { id: 't1' }).action).toBe('upload');
    expect(c('POST', '/api/v1/finance/statements/export').action).toBe('export');
    // a recorded GET hands data out: /export and /print are what they say, anything else is a download
    expect(c('GET', '/api/v1/employees/:empId/documents/:documentId/download', { empId: 'ACV-0011', documentId: 'd1' })).toMatchObject({ action: 'download', description: 'Downloaded a document of ACV-0011' });
    expect(c('GET', '/api/v1/payroll/runs/:id/download', { id: 'r1' }).action).toBe('download');
    expect(c('GET', '/api/v1/finance/statements/export')).toMatchObject({ action: 'export', module: 'Statements' });
    expect(c('GET', '/api/v1/payroll/payslips/:id/print', { id: 'p1' })).toMatchObject({ action: 'print', module: 'Payroll' });
    expect(c('PUT', '/api/v1/settings/:section', { section: 'alert-rules' }).action).toBe('edit');
    expect(c('POST', '/api/v1/finance/ledger/entries')).toMatchObject({ module: 'Ledger', financeLinked: true });
  });

  it('a decorator can name the action and the words', () => {
    expect(classifyRequest({ method: 'POST', route: '/api/v1/tasks/:id/transition', params: { id: 't1' } }, { action: 'submit', description: 'Submitted TSK-0142 for review' })).toMatchObject({
      action: 'submit',
      description: 'Submitted TSK-0142 for review',
    });
  });

  it('describes a refused attempt', () => {
    expect(classifyBlocked({ method: 'GET', route: '/api/v1/finance/statements/balance-sheet', params: {} })).toMatchObject({
      action: 'blocked',
      module: 'Statements',
      description: 'Tried to open Statements (no permission)',
      financeLinked: true,
    });
    expect(classifyBlocked({ method: 'PATCH', route: '/api/v1/org/employees/:empId/level', params: { empId: 'ACV-0003' } }).description).toBe(
      'Tried to change the level of ACV-0003 (no permission)',
    );
    expect(classifyBlocked({ method: 'GET', route: '/api/v1/employees/:empId', params: { empId: 'ACV-0001' } }).description).toBe('Tried to open People (ACV-0001) (no permission)');
    expect(classifyBlocked({ method: 'POST', route: '/api/v1/payroll/runs/:id/approve', params: { id: 'PR-2026-11' } })).toMatchObject({
      module: 'Payroll',
      financeLinked: true,
      description: 'Tried to approve PR-2026-11 in Payroll (no permission)',
    });
  });

  it('leaves to Module 2 events what they already record (login, logout, 2FA, passwords, my devices)', () => {
    for (const route of ['/api/v1/auth/login', '/api/v1/auth/logout', '/api/v1/auth/2fa/verify', '/api/v1/auth/password/change', '/api/v1/auth/sessions/:id', '/api/v1/health']) {
      expect(isRecordedElsewhere(route), route).toBe(true);
    }
    for (const route of ['/api/v1/auth/employees/:empId/unlock', '/api/v1/employees/:empId/basic', '/api/v1/authority']) expect(isRecordedElsewhere(route), route).toBe(false);
    expect(changesData('post')).toBe(true);
    expect(changesData('GET')).toBe(false);
  });

  it('takes the target from the route: an Emp-ID first', () => {
    expect(targetOf({ empId: 'ACV-0007', id: 'x' })).toBe('ACV-0007');
    expect(targetOf({ code: 'dep-eng' })).toBe('dep-eng');
    expect(targetOf({})).toBeNull();
  });
});

describe('logins, logouts and devices', () => {
  it('maps every Module 2 end reason to clicked, timed out, forced or password changed', () => {
    expect(logoutHow('user')).toBe('clicked');
    expect(logoutHow('idle_timeout')).toBe('timed_out');
    expect(logoutHow('max_duration')).toBe('timed_out');
    expect(logoutHow('password_changed')).toBe('password_changed');
    expect(logoutHow('forced')).toBe('forced');
    expect(logoutHow('employee_left')).toBe('forced');
    // a browser idle timeout on a finance screen is recorded after 10 minutes, so the words name both limits
    expect(logoutDescription('idle_timeout')).toBe('Timed out after 30 minutes without activity (10 on a finance screen)');
    // ended from "My devices" on another device: still a click, but the words say where
    expect(logoutHow('user_other_device')).toBe('clicked');
    expect(logoutDescription('user_other_device')).toBe('Signed out from another device');
    // too many wrong codes: shown as forced, but no administrator is named
    expect(logoutHow('too_many_wrong_codes')).toBe('forced');
    expect(logoutDescription('too_many_wrong_codes')).toBe('Signed out after too many wrong codes');
    expect(logoutDescription('too_many_wrong_codes')).not.toMatch(/administrator/);
    expect(logoutDescription('forced')).toBe('Signed out by an administrator');
    expect(loginFailedDescription('invalid_credentials')).toBe('Wrong password');
    expect(securityDescription('account_locked', null)).toBe('Account locked after 5 wrong passwords');
    expect(securityDescription('account_unlocked', 'ACV-0003')).toBe('Account unlocked by ACV-0003');
  });

  it('shows "browser on system" and treats a browser update as the same device', () => {
    expect(deviceLabel({ device: 'Windows computer', browser: 'Chrome 142', os: 'Windows' })).toBe('Chrome 142 on Windows');
    expect(deviceLabel({ device: 'Unknown device', browser: 'Unknown browser', os: 'Unknown' })).toBe('Unknown device');
    expect(deviceFingerprint({ device: 'Windows computer', browser: 'Chrome 142', os: 'Windows' })).toBe(deviceFingerprint({ device: 'Windows computer', browser: 'Chrome 143', os: 'Windows' }));
    expect(deviceFingerprint({ device: 'Android phone', browser: 'Chrome 142', os: 'Android' })).not.toBe(deviceFingerprint({ device: 'Windows computer', browser: 'Chrome 142', os: 'Windows' }));
  });
});

describe('changes in activity search come from the audit log of the same request', () => {
  it('turns before and after into field changes, skipping fields that did not change', () => {
    expect(changesFromAudit({ before: { reportsTo: 'ACV-0004', level: 5 }, after: { reportsTo: 'ACV-0003', level: 5 } })).toEqual([{ field: 'Reports to', from: 'ACV-0004', to: 'ACV-0003' }]);
    expect(changesFromAudit({ before: { head: null }, after: { head: 'ACV-0004' } })).toEqual([{ field: 'Head', from: '', to: 'ACV-0004' }]);
  });

  it('shows only the names of changed profile fields (the values stay in the profile history)', () => {
    expect(changesFromAudit({ section: 'pay', fields: ['Base salary', 'Bank'] })).toEqual([
      { field: 'Base salary', from: '', to: 'changed' },
      { field: 'Bank', from: '', to: 'changed' },
    ]);
  });

  it('ignores details that describe no change', () => {
    expect(changesFromAudit({ duty: 'finance' })).toEqual([]);
    expect(changesFromAudit(null)).toEqual([]);
    expect(changesFromAudit(['x'])).toEqual([]);
    expect(fieldLabel('weekly_capacity_hours')).toBe('Weekly capacity hours');
  });
});
