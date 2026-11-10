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
  const director = person('D', 3, 'director');
  const cto = person('C', 3, 'cto');
  const head = person('H', 4);
  const dev = person('E', 5);
  const ceo = person('CEO', 2);
  const owner = person('O', 1);
  const rules: SameLevelRule[] = [{ managerRoleId: 'director', employeeRoleId: 'cto' }];
  const none = new Set<string>();

  it('allows reporting to a strictly higher level', () => {
    expect(checkReportingLine(dev, head, rules, none)).toEqual([]);
    expect(checkReportingLine(director, ceo, rules, none)).toEqual([]);
    expect(checkReportingLine(dev, director, rules, none)).toEqual([]); // skipping a level is fine
  });

  it('allows same-level reporting ONLY for the configured Director -> CTO pair', () => {
    expect(checkReportingLine(cto, director, rules, none)).toEqual([]);
    expect(checkReportingLine(director, cto, rules, none).map((v) => v.code)).toEqual(['same_level_not_allowed']);
    expect(checkReportingLine(person('H2', 4), head, rules, none).map((v) => v.code)).toEqual(['same_level_not_allowed']);
  });

  it('rejects reporting to someone at a lower level', () => {
    expect(checkReportingLine(head, dev, rules, none).map((v) => v.code)).toEqual(['manager_below_employee']);
  });

  it('rejects self-reporting and reporting loops', () => {
    expect(checkReportingLine(dev, dev, rules, none).map((v) => v.code)).toEqual(['self']);
    // director's downline contains the CTO, so making the CTO the director's manager is a loop
    expect(checkReportingLine(director, cto, rules, new Set(['C'])).map((v) => v.code)).toEqual(['cycle']);
  });

  it('gives the Owner (Level 1) nobody above them', () => {
    expect(checkReportingLine(owner, ceo, rules, none).map((v) => v.code)).toEqual(['owner_has_no_manager']);
  });

  it('rejects people who have left', () => {
    expect(checkReportingLine(dev, person('X', 4, 'x', 'left'), rules, none).map((v) => v.code)).toEqual(['manager_left']);
    expect(checkReportingLine(person('Y', 5, 'y', 'left'), head, rules, none).map((v) => v.code)).toEqual(['employee_left']);
  });
});

describe('approval routing', () => {
  // dev -> head -> director -> ceo -> owner
  const chain = ['head', 'director', 'ceo', 'owner'];
  const base = { requesterId: 'dev', chain, away: [] as AwayPeriod[], onDate: '2026-12-10', authorizedStandInIds: new Set(['peer', 'cto']) };
  const away = (managerId: string, standInId: string | null, startsOn = '2026-12-01', endsOn = '2026-12-15'): AwayPeriod => ({
    managerId,
    standInId,
    startsOn,
    endsOn,
  });

  it('routes to the direct manager by default and then one step up at a time', () => {
    expect(resolveApprover(base)).toMatchObject({ approverId: 'head', seatId: 'head', via: 'manager' });
    expect(resolveApprover({ ...base, afterSeatId: 'head' })).toMatchObject({ approverId: 'director' });
    expect(resolveApprover({ ...base, afterSeatId: 'director' })).toMatchObject({ approverId: 'ceo' });
    expect(resolveFullRoute(base).map((s) => s.approverId)).toEqual(['head', 'director', 'ceo', 'owner']);
  });

  it('returns nobody at the top of the chain', () => {
    expect(resolveApprover({ ...base, afterSeatId: 'owner' }).approverId).toBeNull();
    expect(resolveApprover({ ...base, requesterId: 'owner', chain: [] }).approverId).toBeNull();
  });

  it('routes to the named stand-in during the away dates', () => {
    const result = resolveApprover({ ...base, away: [away('head', 'peer')] });
    expect(result).toMatchObject({ approverId: 'peer', seatId: 'head', via: 'stand_in' });
  });

  it('includes both boundary dates and excludes the days outside', () => {
    const period = [away('head', 'peer', '2026-12-10', '2026-12-12')];
    expect(resolveApprover({ ...base, away: period, onDate: '2026-12-10' }).approverId).toBe('peer');
    expect(resolveApprover({ ...base, away: period, onDate: '2026-12-12' }).approverId).toBe('peer');
    expect(resolveApprover({ ...base, away: period, onDate: '2026-12-09' }).approverId).toBe('head');
    expect(resolveApprover({ ...base, away: period, onDate: '2026-12-13' }).approverId).toBe('head');
  });

  it('goes one level up when the manager is away with no stand-in', () => {
    const result = resolveApprover({ ...base, away: [away('head', null)] });
    expect(result).toMatchObject({ approverId: 'director', seatId: 'director' });
    expect(result.skipped).toEqual([{ seatId: 'head', reason: 'away_no_stand_in' }]);
  });

  it('ignores revoked periods', () => {
    expect(resolveApprover({ ...base, away: [{ ...away('head', 'peer'), revoked: true }] }).approverId).toBe('head');
  });

  it('never lets the requester approve their own request (stand-in is the requester)', () => {
    const result = resolveApprover({ ...base, away: [away('head', 'dev')], authorizedStandInIds: new Set(['dev']) });
    expect(result.approverId).toBe('director');
    expect(result.skipped[0].reason).toBe('stand_in_is_requester');
  });

  it('sends the request one level up when the approver would be the same person', () => {
    // the requester is also the seat holder's stand-in elsewhere in the chain: approver === requester
    const result = resolveApprover({ ...base, requesterId: 'director', chain: ['ceo', 'owner'], away: [away('ceo', 'director')], authorizedStandInIds: new Set(['director']) });
    expect(result.approverId).toBe('owner');
  });

  it('skips a stand-in who is not authorized to approve', () => {
    const result = resolveApprover({ ...base, away: [away('head', 'intern')] });
    expect(result.approverId).toBe('director');
    expect(result.skipped[0].reason).toBe('stand_in_not_authorized');
  });

  it('passes over a person who has left and uses the next eligible person upward', () => {
    const result = resolveApprover({ ...base, inactiveIds: new Set(['head']) });
    expect(result).toMatchObject({ approverId: 'director', seatId: 'director' });
    expect(result.skipped).toEqual([{ seatId: 'head', reason: 'not_active' }]);
  });

  it('follows the real reporting chain: CTO -> Director, both Level 3 (C2)', () => {
    const result = resolveApprover({ ...base, requesterId: 'cto', chain: ['director', 'ceo', 'owner'] });
    expect(result.approverId).toBe('director');
  });

  it('only escalates one reporting relationship at a time even when two seats are away', () => {
    const route = resolveFullRoute({ ...base, away: [away('head', null), away('director', 'cto')] });
    expect(route.map((s) => [s.approverId, s.via])).toEqual([
      ['cto', 'stand_in'],
      ['ceo', 'manager'],
      ['owner', 'manager'],
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
