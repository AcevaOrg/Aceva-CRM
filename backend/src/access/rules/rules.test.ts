import { describe, expect, it } from 'vitest';
import { canAssignTask, isSelfApproval, resolveApprover, resolveFullRoute, type AwayPeriod } from './approval-routing';
import { checkReportingLine, type RulePerson, type SameLevelRule } from './reporting-rules';

const person = (id: string, levelNumber: number, roleId = `role-${id}`, status: RulePerson['status'] = 'active'): RulePerson => ({
  id,
  empId: `ACV-${id}`,
  levelNumber,
  roleId,
  status,
});

describe('reporting line rules (C2)', () => {
  // The final company structure: L1 CEO / Founder / Owner > L2 Director > L3 CTO > L5 Developer / SQA, and L4 Sales
  // and Finance under the Director. Nobody reports to someone at the same level: no same-level pair is configured.
  const owner = person('O', 1, 'owner');
  const director = person('D', 2, 'director');
  const cto = person('C', 3, 'cto');
  const sales = person('S', 4, 'sales');
  const finance = person('F', 4, 'finance');
  const dev = person('E', 5, 'employee');
  const rules: SameLevelRule[] = []; // the company configures no same-level reporting
  const none = new Set<string>();

  it('allows reporting to a strictly higher level', () => {
    expect(checkReportingLine(director, owner, rules, none)).toEqual([]);
    expect(checkReportingLine(cto, director, rules, none)).toEqual([]); // the CTO is strictly below the Director
    expect(checkReportingLine(sales, director, rules, none)).toEqual([]);
    expect(checkReportingLine(finance, director, rules, none)).toEqual([]);
    expect(checkReportingLine(dev, cto, rules, none)).toEqual([]);
    expect(checkReportingLine(dev, director, rules, none)).toEqual([]); // skipping a level is fine
  });

  it('refuses every same-level line, because none is configured (there is no CTO-to-Director exception any more)', () => {
    expect(checkReportingLine(person('C2', 3, 'cto'), cto, rules, none).map((v) => v.code)).toEqual(['same_level_not_allowed']);
    expect(checkReportingLine(sales, finance, rules, none).map((v) => v.code)).toEqual(['same_level_not_allowed']);
    expect(checkReportingLine(person('E2', 5, 'employee'), dev, rules, none).map((v) => v.code)).toEqual(['same_level_not_allowed']);
  });

  it('still honours a same-level pair if one is ever configured (the rule table stays)', () => {
    const configured: SameLevelRule[] = [{ managerRoleId: 'sales', employeeRoleId: 'finance' }];
    expect(checkReportingLine(finance, sales, configured, none)).toEqual([]);
    expect(checkReportingLine(sales, finance, configured, none).map((v) => v.code)).toEqual(['same_level_not_allowed']); // one direction only
  });

  it('rejects reporting to someone at a lower level', () => {
    expect(checkReportingLine(sales, dev, rules, none).map((v) => v.code)).toEqual(['manager_below_employee']);
    expect(checkReportingLine(director, cto, rules, none).map((v) => v.code)).toEqual(['manager_below_employee']);
  });

  it('rejects self-reporting and reporting loops', () => {
    expect(checkReportingLine(dev, dev, rules, none).map((v) => v.code)).toEqual(['self']);
    // the CTO's downline contains the developer, so making the developer the CTO's manager is a loop
    expect(checkReportingLine(cto, dev, rules, new Set(['E'])).map((v) => v.code)).toEqual(['cycle']);
  });

  it('gives the CEO / Founder / Owner (Level 1) nobody above them', () => {
    expect(checkReportingLine(owner, director, rules, none).map((v) => v.code)).toEqual(['owner_has_no_manager']);
  });

  it('rejects people who have left', () => {
    expect(checkReportingLine(dev, person('X', 3, 'cto', 'left'), rules, none).map((v) => v.code)).toEqual(['manager_left']);
    expect(checkReportingLine(person('Y', 5, 'employee', 'left'), cto, rules, none).map((v) => v.code)).toEqual(['employee_left']);
  });
});

describe('approval routing', () => {
  // A developer's chain: dev -> cto -> director -> owner. The owner (Level 1) approves only for his direct report.
  const chain = ['cto', 'director', 'owner'];
  const base = {
    requesterId: 'dev',
    chain,
    away: [] as AwayPeriod[],
    onDate: '2026-12-10',
    authorizedStandInIds: new Set(['peer', 'director']),
    directReportsOnlyIds: new Set(['owner']),
  };
  const away = (managerId: string, standInId: string | null, startsOn = '2026-12-01', endsOn = '2026-12-15'): AwayPeriod => ({
    managerId,
    standInId,
    startsOn,
    endsOn,
  });

  it('routes to the direct manager by default and then one step up at a time, never on to the owner', () => {
    expect(resolveApprover(base)).toMatchObject({ approverId: 'cto', seatId: 'cto', via: 'manager' });
    expect(resolveApprover({ ...base, afterSeatId: 'cto' })).toMatchObject({ approverId: 'director' });
    // the Director is the last approver for everyone below him: the owner approves only for his direct report
    const top = resolveApprover({ ...base, afterSeatId: 'director' });
    expect(top.approverId).toBeNull();
    expect(top.skipped).toEqual([{ seatId: 'owner', reason: 'direct_reports_only' }]);
    expect(resolveFullRoute(base).map((s) => s.approverId)).toEqual(['cto', 'director']);
  });

  it("sends the Director's OWN request to the CEO / Founder / Owner (nobody approves their own request)", () => {
    const own = { ...base, requesterId: 'director', chain: ['owner'] };
    expect(resolveApprover(own)).toMatchObject({ approverId: 'owner', seatId: 'owner', via: 'manager' });
    expect(resolveFullRoute(own).map((s) => s.approverId)).toEqual(['owner']);
  });

  it('returns nobody at the top of the chain', () => {
    expect(resolveApprover({ ...base, requesterId: 'director', chain: ['owner'], afterSeatId: 'owner' }).approverId).toBeNull();
    expect(resolveApprover({ ...base, requesterId: 'owner', chain: [] }).approverId).toBeNull();
  });

  it('routes to the named stand-in during the away dates', () => {
    const result = resolveApprover({ ...base, away: [away('cto', 'director')] });
    expect(result).toMatchObject({ approverId: 'director', seatId: 'cto', via: 'stand_in' });
  });

  it('includes both boundary dates and excludes the days outside', () => {
    const period = [away('cto', 'peer', '2026-12-10', '2026-12-12')];
    expect(resolveApprover({ ...base, away: period, onDate: '2026-12-10' }).approverId).toBe('peer');
    expect(resolveApprover({ ...base, away: period, onDate: '2026-12-12' }).approverId).toBe('peer');
    expect(resolveApprover({ ...base, away: period, onDate: '2026-12-09' }).approverId).toBe('cto');
    expect(resolveApprover({ ...base, away: period, onDate: '2026-12-13' }).approverId).toBe('cto');
  });

  it('goes one level up when the manager is away with no stand-in', () => {
    const result = resolveApprover({ ...base, away: [away('cto', null)] });
    expect(result).toMatchObject({ approverId: 'director', seatId: 'director' });
    expect(result.skipped).toEqual([{ seatId: 'cto', reason: 'away_no_stand_in' }]);
  });

  it('lets a request wait rather than climb to the owner when the Director is away with no stand-in', () => {
    const result = resolveApprover({ ...base, requesterId: 'cto', chain: ['director', 'owner'], away: [away('director', null)] });
    expect(result.approverId).toBeNull();
    expect(result.skipped).toEqual([
      { seatId: 'director', reason: 'away_no_stand_in' },
      { seatId: 'owner', reason: 'direct_reports_only' },
    ]);
  });

  it('ignores revoked periods', () => {
    expect(resolveApprover({ ...base, away: [{ ...away('cto', 'peer'), revoked: true }] }).approverId).toBe('cto');
  });

  it('never lets the requester approve their own request (stand-in is the requester)', () => {
    const result = resolveApprover({ ...base, away: [away('cto', 'dev')], authorizedStandInIds: new Set(['dev']) });
    expect(result.approverId).toBe('director');
    expect(result.skipped[0].reason).toBe('stand_in_is_requester');
  });

  it('sends the request one level up when the approver would be the same person', () => {
    // a plain chain without a Level 1 seat: the requester stands in for "a", so the request goes on to "b"
    const plain = resolveApprover({ requesterId: 'x', chain: ['a', 'b'], away: [away('a', 'x')], onDate: '2026-12-10', authorizedStandInIds: new Set(['x']) });
    expect(plain.approverId).toBe('b');
    // in the company: the CTO is the Director's stand-in, so the CTO's own request passes the Director's seat, and the
    // owner does not approve for the CTO, so the request waits for the Director
    const result = resolveApprover({ ...base, requesterId: 'cto', chain: ['director', 'owner'], away: [away('director', 'cto')], authorizedStandInIds: new Set(['cto']) });
    expect(result.approverId).toBeNull();
    expect(result.skipped.map((s) => s.reason)).toEqual(['stand_in_is_requester', 'direct_reports_only']);
  });

  it('skips a stand-in who is not authorized to approve', () => {
    const result = resolveApprover({ ...base, away: [away('cto', 'intern')] });
    expect(result.approverId).toBe('director');
    expect(result.skipped[0].reason).toBe('stand_in_not_authorized');
  });

  it('passes over a person who has left and uses the next eligible person upward', () => {
    const result = resolveApprover({ ...base, inactiveIds: new Set(['cto']) });
    expect(result).toMatchObject({ approverId: 'director', seatId: 'director' });
    expect(result.skipped).toEqual([{ seatId: 'cto', reason: 'not_active' }]);
  });

  it('follows the real reporting chain: the CTO (Level 3) is approved by the Director (Level 2)', () => {
    const result = resolveApprover({ ...base, requesterId: 'cto', chain: ['director', 'owner'] });
    expect(result.approverId).toBe('director');
  });

  it('only escalates one reporting relationship at a time even when two seats are away', () => {
    // dev -> lead -> cto -> director -> owner, with the lead away (nobody covering) and the CTO covered by a peer
    const route = resolveFullRoute({ ...base, chain: ['lead', 'cto', 'director', 'owner'], away: [away('lead', null), away('cto', 'peer')] });
    expect(route.map((s) => [s.approverId, s.via])).toEqual([
      ['peer', 'stand_in'],
      ['director', 'manager'],
    ]);
  });
});

describe('fixed business rules', () => {
  it('blocks self-approval', () => {
    expect(isSelfApproval('a', 'a')).toBe(true);
    expect(isSelfApproval('a', 'b')).toBe(false);
  });

  it('lets tasks move down only', () => {
    const below = new Set(['x', 'y']);
    expect(canAssignTask('boss', 'x', below)).toBe(true);
    expect(canAssignTask('boss', 'boss', below)).toBe(false); // not to self
    expect(canAssignTask('boss', 'above', below)).toBe(false); // not up
    expect(canAssignTask('boss', 'beside', below)).toBe(false); // not sideways
  });
});
