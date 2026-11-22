import { describe, expect, it } from 'vitest';
import { hoursText, openHours, openTaskCount, workloadAfter, workloadWarning, type WorkloadTask } from './task-workload';
import { applySizeUpdate, checkSizeTable, DEFAULT_SIZE_RULES, ruleFor, sizeChanges, sizeOrder, type SizeRule } from './task-sizes';

const task = (status: WorkloadTask['status'], estimatedHours: number, personal = false): WorkloadTask => ({ status, estimatedHours, personal });

describe('workload', () => {
  it('adds up the hours of open work tasks: personal to-dos and finished or cancelled work do not count', () => {
    const tasks = [task('assigned', 16), task('in_progress', 12), task('submitted', 4), task('on_hold', 2), task('approved', 40), task('cancelled', 40), task('in_progress', 8, true)];
    expect(openHours(tasks)).toBe(34);
    expect(openTaskCount(tasks)).toBe(4);
    expect(openHours([])).toBe(0);
  });

  it('is fine up to the weekly capacity, exactly at it included', () => {
    expect(workloadAfter({ openHours: 24, addedHours: 16, capacity: 40 })).toMatchObject({ after: 40, over: false, overBy: 0 });
    expect(workloadAfter({ openHours: 10, addedHours: 4, capacity: 40 }).over).toBe(false);
  });

  it('warns when the new task pushes the person over, with the plan wording', () => {
    const check = workloadAfter({ openHours: 30, addedHours: 16, capacity: 40 });
    expect(check).toMatchObject({ after: 46, over: true, overBy: 6 });
    const warning = workloadWarning('Ali Raza', 'ACV-0008', check);
    expect(warning).toMatchObject({ code: 'overloaded', message: 'This puts Ali Raza at 46 h of 40 h this week.' });
    expect(warning?.details).toMatchObject({ empId: 'ACV-0008', openHours: 30, addedHours: 16, capacity: 40 });
  });

  it('uses the part-time capacity of the person', () => {
    expect(workloadAfter({ openHours: 15, addedHours: 8, capacity: 20 }).over).toBe(true);
    expect(workloadAfter({ openHours: 8, addedHours: 8, capacity: 20 }).over).toBe(false);
  });

  it('gives no warning when it fits, and prints half hours without noise', () => {
    expect(workloadWarning('Ali', 'ACV-0008', workloadAfter({ openHours: 1, addedHours: 1, capacity: 40 }))).toBeNull();
    expect(hoursText(46)).toBe('46');
    expect(hoursText(46.5)).toBe('46.5');
    expect(workloadAfter({ openHours: 0.1, addedHours: 0.2, capacity: 40 }).after).toBe(0.3);
  });
});

describe('the size table', () => {
  it('the defaults are the plan table: XS 1 pt, S 2, M 3, L 5, XL not scored and must be split', () => {
    expect(DEFAULT_SIZE_RULES.map((r) => [r.size, r.hours, r.points, r.days])).toEqual([
      ['XS', 2, 1, 0],
      ['S', 4, 2, 1],
      ['M', 16, 3, 3],
      ['L', 40, 5, 7],
      ['XL', 48, 0, null],
    ]);
    expect(checkSizeTable(DEFAULT_SIZE_RULES)).toEqual([]);
    expect(ruleFor(DEFAULT_SIZE_RULES, 'M').points).toBe(3);
    expect(() => ruleFor([], 'M')).toThrow();
    expect(sizeOrder('XS')).toBeLessThan(sizeOrder('XL'));
  });

  const m = ruleFor(DEFAULT_SIZE_RULES, 'M');
  const xl = ruleFor(DEFAULT_SIZE_RULES, 'XL');
  const withRule = (rule: SizeRule): SizeRule[] => DEFAULT_SIZE_RULES.map((r) => (r.size === rule.size ? rule : r));

  it('applies a change to one row and leaves the rest alone', () => {
    expect(applySizeUpdate(m, { hours: 20, points: 4 })).toEqual({ ...m, hours: 20, points: 4 });
    expect(applySizeUpdate(m, {})).toEqual(m);
  });

  it('XL always stays "must be split": its days cannot be set', () => {
    expect(applySizeUpdate(xl, { days: 10, hours: 60 })).toEqual({ ...xl, hours: 60, days: null });
  });

  it('a change keeps the sizes in order: a bigger size never has fewer hours, points or days', () => {
    expect(checkSizeTable(withRule({ ...m, hours: 20, points: 4, days: 4 }))).toEqual([]);
    expect(checkSizeTable(withRule({ ...m, hours: 3 })).map((i) => i.code)).toEqual(['hours_order']);
    expect(checkSizeTable(withRule({ ...m, points: 1 })).map((i) => i.code)).toContain('points_order');
    expect(checkSizeTable(withRule({ ...m, days: 0 })).map((i) => i.code)).toContain('days_order');
  });

  it('refuses suggested days on XL and a missing number of days on the others', () => {
    expect(checkSizeTable(withRule({ ...xl, days: 5 })).map((i) => i.code)).toContain('xl_days');
    expect(checkSizeTable(withRule({ ...m, days: null })).map((i) => i.code)).toContain('days_required');
    expect(checkSizeTable(withRule({ ...m, hours: 0 })).map((i) => i.code)).toContain('hours_positive');
  });

  it('lists what changed for the history', () => {
    expect(sizeChanges(m, { ...m, hours: 20, days: 4 })).toEqual([
      { field: 'hours', from: '16', to: '20' },
      { field: 'days', from: '3', to: '4' },
    ]);
    expect(sizeChanges(m, m)).toEqual([]);
    expect(sizeChanges(xl, { ...xl, days: null, points: 1 })).toEqual([{ field: 'points', from: '0', to: '1' }]);
  });
});
