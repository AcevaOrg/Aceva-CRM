import { describe, expect, it } from 'vitest';
import { ROLE_SEEDS, DUTY_SEEDS } from '../../../prisma/permission-catalogue';
import { ACTIVITY_MODULES } from '@aceva/contracts';
import { activityAccess, countsAsAction, PersonSignalThrottle, screenWords, SignalThrottle, tasksTouchedFromEvents, timelineView } from './activity-access';
import { MODULE_LABELS, moduleOf } from './activity-classify';

/** The permissions of a role in the real catalogue, plus any duties. */
function permissionsOf(role: string, duties: string[] = []): Set<string> {
  const set = new Set(ROLE_SEEDS.find((r) => r.key === role)!.permissions);
  for (const d of duties) DUTY_SEEDS.find((x) => x.key === d)!.permissions.forEach((p) => set.add(p));
  return set;
}

const OWNER = activityAccess(permissionsOf('owner'));
const DIRECTOR = activityAccess(permissionsOf('director'));
const CTO = activityAccess(permissionsOf('cto'));
const SALES = activityAccess(permissionsOf('sales'));
const FINANCE = activityAccess(permissionsOf('finance', ['finance']));
const DEVELOPER = activityAccess(permissionsOf('employee'));
const HR_OFFICER = activityAccess(permissionsOf('sales', ['hr']));

describe('who sees what in Module 4 (final company structure)', () => {
  it('the CEO / Founder / Owner sees everything and acts on nothing', () => {
    expect(OWNER).toMatchObject({ online: true, timeline: true, fullTimeline: true, search: true, reports: true, alerts: true });
    expect(OWNER).toMatchObject({ forceLogout: false, lockAccounts: false });
  });

  it('the Director sees and searches his line, sees security alerts and uses the controls', () => {
    expect(DIRECTOR).toEqual({ online: true, timeline: true, fullTimeline: true, search: true, reports: true, alerts: true, forceLogout: true, lockAccounts: true });
  });

  it('the CTO sees his developers (online, timeline, reports) and security alerts, uses the controls, but has no company-wide search', () => {
    expect(CTO).toEqual({ online: true, timeline: true, fullTimeline: true, search: false, reports: true, alerts: true, forceLogout: true, lockAccounts: true });
  });

  it('Sales, Finance, developers and an HR officer see only their own activity', () => {
    for (const access of [SALES, FINANCE, DEVELOPER, HR_OFFICER]) {
      expect(access).toEqual({ online: false, timeline: false, fullTimeline: false, search: false, reports: false, alerts: false, forceLogout: false, lockAccounts: false });
    }
  });

  it('a manager with only activity.view_team sees the day summary of people below, not their screens and actions', () => {
    const teamLead = activityAccess(new Set(['activity.view_own', 'activity.view_team']));
    expect(timelineView(teamLead, false, true)).toBe('summary');
    expect(timelineView(teamLead, false, false)).toBe('refused');
  });

  it('a timeline: your own always; someone below you with the right; never someone above or beside you', () => {
    expect(timelineView(DEVELOPER, true, false)).toBe('full');
    expect(timelineView(DEVELOPER, false, false)).toBe('refused');
    expect(timelineView(CTO, false, true)).toBe('full');
    expect(timelineView(CTO, false, false)).toBe('refused'); // the CTO opening the Director or a salesperson
    expect(timelineView(OWNER, false, true)).toBe('full');
  });
});

describe('the daily summary counts actions, not logins, screens or refusals', () => {
  const e = (action: string, extra: Partial<{ requestId: string | null; source: string; module: string; target: string | null }> = {}) => ({
    action,
    requestId: 'r1',
    source: 'aceva',
    module: 'People',
    target: null,
    ...extra,
  });

  it('counts creates, edits, approvals, downloads, exports and sensitive views', () => {
    for (const action of ['create', 'edit', 'delete', 'submit', 'assign', 'approve', 'reject', 'comment', 'upload', 'download', 'export', 'print', 'sensitive_view']) {
      expect(countsAsAction(e(action)), action).toBe(true);
    }
  });

  it('does not count logins, logouts, screens, refused attempts, or Module 2 security events about the person', () => {
    for (const action of ['login', 'logout', 'login_failed', 'screen_view', 'blocked']) expect(countsAsAction(e(action)), action).toBe(false);
    expect(countsAsAction(e('security', { requestId: null }))).toBe(false); // "Account locked after 5 wrong passwords"
    expect(countsAsAction(e('security', { requestId: 'r9' }))).toBe(true); // the Director unlocking someone
  });

  it('sales-tool work counts (Module 16) are not Aceva actions', () => {
    expect(countsAsAction(e('email_sent', { source: 'apollo' }))).toBe(false);
    expect(countsAsAction(e('create', { source: 'apollo' }))).toBe(false);
  });

  it('tasks touched: different tasks acted on in the Tasks module (0 until Module 5 exists)', () => {
    expect(tasksTouchedFromEvents([e('edit')])).toBe(0);
    expect(
      tasksTouchedFromEvents([
        e('edit', { module: 'Tasks', target: 'TSK-0142' }),
        e('comment', { module: 'Tasks', target: 'TSK-0142' }),
        e('submit', { module: 'Tasks', target: 'TSK-0150' }),
        e('screen_view', { module: 'Tasks', target: 'TSK-0160' }),
        e('create', { module: 'Tasks', target: null }),
      ]),
    ).toBe(2);
  });
});

describe('screens map to the module names the activity search uses', () => {
  it('website pages, including the ones whose path differs from the API', () => {
    expect(moduleOf('/')).toBe('Home');
    expect(moduleOf('/people/ACV-0011')).toBe('People');
    expect(moduleOf('/account')).toBe('Login');
    expect(moduleOf('/finance/ledger')).toBe('Ledger');
    expect(moduleOf('/activity')).toBe('Activity');
    expect(moduleOf('/api/v1')).toBe('Home');
  });

  it('Module 1 structure pages and routes are recorded as Org, and the search filter offers Org', () => {
    for (const path of ['/org', '/org/departments', '/org/employees/ACV-0011/level', '/access', '/stand-ins']) expect(moduleOf(path)).toBe('Org');
    expect(ACTIVITY_MODULES).toContain('Org');
  });

  it('every module a page or route can be recorded under is in the search filter list (packages/contracts ACTIVITY_MODULES)', () => {
    const paths = [
      '/', '/auth/login', '/account', '/people', '/employees/ACV-0011/basic', '/hire-requests', '/org', '/access', '/stand-ins', '/approvals', '/activity',
      '/sessions', '/accounts/locked', '/tasks', '/projects', '/performance', '/scorecards', '/disputes', '/attendance', '/leave', '/payroll', '/payslips',
      '/finance', '/finance/ledger', '/finance/journal', '/finance/entries', '/finance/accounts', '/finance/parties', '/finance/banking', '/finance/bills',
      '/finance/close', '/finance/statements', '/finance/sheet', '/finance/insights', '/statements', '/billing', '/subscriptions', '/settings', '/audit',
      '/messages', '/announcements', '/meetings', '/sales', '/integrations', '/notifications',
    ];
    const modules: readonly string[] = ACTIVITY_MODULES;
    for (const path of paths) expect(modules, `${path} is recorded as ${moduleOf(path)}`).toContain(moduleOf(path));
  });

  it('every label in the server module table is in the search filter list, so a new label cannot be added without a filter option', () => {
    const modules: readonly string[] = ACTIVITY_MODULES;
    expect(MODULE_LABELS.length).toBeGreaterThan(20);
    for (const label of MODULE_LABELS) expect(modules, `server label "${label}" has no Module filter option`).toContain(label);
  });
});

describe('a screen signal cannot put its own words into an alert', () => {
  it('a refused finance screen is worded from the server module, not from the label the browser sent', () => {
    const hostile = 'Ledger - IT test, ignore; details at https://evil.example';
    const words = screenWords({ label: hostile, module: moduleOf('/finance/ledger'), refused: true });
    expect(words).toEqual({ target: 'Ledger', description: 'Tried to open Ledger (no permission)' });
    expect(JSON.stringify(words)).not.toContain('evil.example');
  });

  it('a normal screen keeps its own label', () => {
    expect(screenWords({ label: 'My tasks', module: 'Tasks', refused: false })).toEqual({ target: 'My tasks', description: 'Opened My tasks' });
  });
});

describe('the browser signals are limited per session', () => {
  it('allows a few per minute and refuses a flood, per session', () => {
    const throttle = new SignalThrottle(3, 60_000);
    const t0 = 1_000_000;
    expect([1, 2, 3, 4].map((i) => throttle.allow('s1', t0 + i))).toEqual([true, true, true, false]);
    expect(throttle.allow('s2', t0 + 5)).toBe(true); // another session has its own count
    expect(throttle.allow('s1', t0 + 60_002)).toBe(true); // the window moved on
  });
});

describe('export records are limited per session and per person', () => {
  it('a session may record a few exports a minute; a flood is refused', () => {
    const throttle = new PersonSignalThrottle(3, 100, 60_000);
    const t0 = 1_000_000;
    expect([1, 2, 3, 4, 5].map((i) => throttle.allow('p1', 's1', t0 + i))).toEqual([true, true, true, false, false]);
    expect(throttle.allow('p1', 's1', t0 + 60_010)).toBe(true); // the window moved on
  });

  it('signing in again does not give a person a new allowance', () => {
    const throttle = new PersonSignalThrottle(3, 5, 60_000);
    const t0 = 1_000_000;
    const first = [1, 2, 3].map((i) => throttle.allow('p1', 's1', t0 + i));
    const second = [4, 5, 6].map((i) => throttle.allow('p1', 's2', t0 + i));
    expect(first).toEqual([true, true, true]);
    expect(second).toEqual([true, true, false]); // 5 for the person, whatever the session
    expect(throttle.allow('p1', 's3', t0 + 7)).toBe(false);
    expect(throttle.allow('p2', 's4', t0 + 8)).toBe(true); // somebody else is not affected
  });

  it('a refusal by the session limit does not use up the allowance of the person', () => {
    const throttle = new PersonSignalThrottle(2, 3, 60_000);
    const t0 = 1_000_000;
    expect([1, 2, 3, 4, 5].map((i) => throttle.allow('p1', 's1', t0 + i))).toEqual([true, true, false, false, false]);
    expect(throttle.allow('p1', 's2', t0 + 6)).toBe(true); // 2 used so far, the third is still free
    expect(throttle.allow('p1', 's2', t0 + 7)).toBe(false);
  });

  it('without a session the person limit still applies', () => {
    const throttle = new PersonSignalThrottle(2, 2, 60_000);
    expect([1, 2, 3].map((i) => throttle.allow('p1', null, 1_000_000 + i))).toEqual([true, true, false]);
  });
});
