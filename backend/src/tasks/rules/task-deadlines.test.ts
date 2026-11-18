import { describe, expect, it } from 'vitest';
import {
  addDays,
  addWorkingDays,
  checkDeadline,
  checkDeadlineChange,
  checkExtension,
  canRequestExtensionIn,
  givenWorkingDays,
  isOnTime,
  isoWeekdayOf,
  isWorkingDay,
  nextWorkingDay,
  pakistanInstant,
  suggestedDeadline,
  timelinessDeadline,
  workingDaysBetween,
} from './task-deadlines';

/** A moment in Pakistan time. 2026-11-16 is a Monday. */
const pk = (day: string, time = '09:00') => new Date(`${day}T${time}:00+05:00`);
const MON = '2026-11-16';
const NOW = pk(MON, '08:00');

describe('working days', () => {
  it('Monday to Friday are working days; Saturday, Sunday and holidays are not', () => {
    expect(isWorkingDay('2026-11-16')).toBe(true);
    expect(isWorkingDay('2026-11-20')).toBe(true);
    expect(isWorkingDay('2026-11-14')).toBe(false);
    expect(isWorkingDay('2026-11-15')).toBe(false);
    expect(isWorkingDay('2026-11-16', ['2026-11-16'])).toBe(false);
    expect(isWorkingDay('2026-11-16', new Set(['2026-11-16']))).toBe(false);
  });

  it('knows the ISO weekday (Monday 1 ... Sunday 7)', () => {
    expect(isoWeekdayOf('2026-11-16')).toBe(1);
    expect(isoWeekdayOf('2026-11-20')).toBe(5);
    expect(isoWeekdayOf('2026-11-22')).toBe(7);
  });

  it('adds working days and skips weekends', () => {
    expect(addWorkingDays('2026-11-16', 3)).toBe('2026-11-19');
    expect(addWorkingDays('2026-11-19', 3)).toBe('2026-11-24');
    expect(addWorkingDays('2026-11-20', 1)).toBe('2026-11-23');
    expect(addWorkingDays('2026-11-16', 7)).toBe('2026-11-25');
  });

  it('skips company holidays', () => {
    expect(addWorkingDays('2026-11-19', 3, ['2026-11-23'])).toBe('2026-11-25');
    expect(addWorkingDays('2026-11-16', 1, ['2026-11-17'])).toBe('2026-11-18');
  });

  it('zero days means the same working day, or the next one when the start is not a working day', () => {
    expect(addWorkingDays('2026-11-16', 0)).toBe('2026-11-16');
    expect(addWorkingDays('2026-11-14', 0)).toBe('2026-11-16');
    expect(nextWorkingDay('2026-11-14', ['2026-11-16'])).toBe('2026-11-17');
  });

  it('counts working days between two days, both included', () => {
    expect(workingDaysBetween('2026-11-16', '2026-11-20')).toBe(5);
    expect(workingDaysBetween('2026-11-16', '2026-11-20', ['2026-11-18'])).toBe(4);
    expect(workingDaysBetween('2026-11-19', '2026-11-24')).toBe(4);
    expect(workingDaysBetween('2026-11-20', '2026-11-16')).toBe(0);
    expect(workingDaysBetween('2026-11-14', '2026-11-15')).toBe(0);
  });

  it('counts by arithmetic and agrees with counting every day, with weekend, repeated and out-of-range holidays', () => {
    const reference = (a: string, b: string, holidays: string[]): number => {
      let n = 0;
      for (let d = a; d <= b; d = addDays(d, 1)) if (isWorkingDay(d, holidays)) n++;
      return n;
    };
    const holidays = ['2026-11-18', '2026-11-18', '2026-11-21', '2026-12-25', '2027-01-01', '2020-01-01'];
    for (let from = 0; from < 20; from++) {
      for (let length = 0; length < 60; length += 3) {
        const a = addDays('2026-11-12', from);
        const b = addDays(a, length);
        expect(workingDaysBetween(a, b, holidays)).toBe(reference(a, b, holidays));
        expect(workingDaysBetween(a, b)).toBe(reference(a, b, []));
      }
    }
  });

  it('a far-off deadline costs the same as a near one (9999-12-31 used to run for ever)', () => {
    const started = Date.now();
    expect(workingDaysBetween('2026-11-16', '9999-12-31')).toBeGreaterThan(1_000_000);
    expect(givenWorkingDays(pk(MON), new Date('9999-12-31T00:00:00.000Z'))).toBeGreaterThan(1_000_000);
    expect(workingDaysBetween('2026-11-16', '2100-12-31', ['2027-01-01'])).toBeGreaterThan(19_000);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('adds calendar days across month ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });
});

describe('the suggested deadline', () => {
  it('is 18:00 Pakistan time on the last working day (M = 3 working days)', () => {
    const d = suggestedDeadline(pk(MON, '09:00'), 3)!;
    expect(d.toISOString()).toBe('2026-11-19T13:00:00.000Z'); // Thursday 18:00 in Pakistan
  });

  it('skips the weekend and the holidays', () => {
    expect(suggestedDeadline(pk('2026-11-19'), 3)!.toISOString()).toBe(pk('2026-11-24', '18:00').toISOString());
    expect(suggestedDeadline(pk('2026-11-19'), 3, ['2026-11-23'])!.toISOString()).toBe(pk('2026-11-25', '18:00').toISOString());
  });

  it('is the same day for an XS task, and the next working day when it is already past 18:00', () => {
    expect(suggestedDeadline(pk(MON, '09:00'), 0)!.toISOString()).toBe(pk(MON, '18:00').toISOString());
    expect(suggestedDeadline(pk(MON, '19:00'), 0)!.toISOString()).toBe(pk('2026-11-17', '18:00').toISOString());
    expect(suggestedDeadline(pk('2026-11-20', '20:00'), 0)!.toISOString()).toBe(pk('2026-11-23', '18:00').toISOString());
  });

  it('is nothing for XL: it must be split first', () => {
    expect(suggestedDeadline(pk(MON), null)).toBeNull();
  });

  it('counts the start day by its Pakistan date, not its UTC date', () => {
    // 2026-11-16 23:30 Pakistan time is still the 16th in Pakistan (18:30 UTC), and 00:30 on the 17th is the 17th.
    expect(suggestedDeadline(pk(MON, '23:30'), 1)!.toISOString()).toBe(pk('2026-11-17', '18:00').toISOString());
    expect(suggestedDeadline(pk('2026-11-17', '00:30'), 1)!.toISOString()).toBe(pk('2026-11-18', '18:00').toISOString());
  });

  it('builds an instant from a Pakistan day and a time', () => {
    expect(pakistanInstant('2026-11-16', '09:00').toISOString()).toBe('2026-11-16T04:00:00.000Z');
    expect(pakistanInstant('2026-11-16').toISOString()).toBe('2026-11-15T19:00:00.000Z');
  });
});

describe('checking a deadline', () => {
  const base = { now: NOW, size: 'M' as const, neededDays: 3, start: pk(MON) };

  it('accepts a deadline that gives the size the working days it usually needs', () => {
    const r = checkDeadline({ ...base, deadline: pk('2026-11-19', '18:00') });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('refuses a deadline more than two years after the start (and never counts days for it)', () => {
    const started = Date.now();
    for (const deadline of ['9999-12-31T00:00:00.000Z', '2029-01-01T00:00:00.000Z']) {
      const r = checkDeadline({ ...base, deadline: new Date(deadline) });
      expect(r.errors.map((e) => e.code)).toEqual(['deadline_too_far']);
      expect(r.warnings).toEqual([]);
      expect(checkDeadline({ ...base, deadline: new Date(deadline), personal: true }).errors.map((e) => e.code)).toEqual(['deadline_too_far']);
    }
    expect(checkDeadline({ ...base, deadline: new Date('2028-11-15T00:00:00.000Z') }).errors).toEqual([]); // inside the two years
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('warns, in the plan words, when the deadline is shorter than the size usually needs', () => {
    const r = checkDeadline({ ...base, deadline: pk('2026-11-17', '18:00') });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({
      code: 'deadline_too_short',
      message: 'An M task usually needs 3 working days; you set 1. Continue?',
      details: { size: 'M', neededDays: 3, givenDays: 1 },
    });
  });

  it('says "1 working day" (singular) for an S task', () => {
    const r = checkDeadline({ ...base, size: 'S', neededDays: 1, deadline: pk(MON, '18:00') });
    expect(r.warnings[0].message).toBe('An S task usually needs 1 working day; you set 0. Continue?');
  });

  it('counts only working days: a weekend inside the range does not help, a holiday takes one away', () => {
    expect(checkDeadline({ ...base, start: pk('2026-11-19'), deadline: pk('2026-11-24', '18:00') }).warnings).toEqual([]);
    const r = checkDeadline({ ...base, start: pk('2026-11-19'), deadline: pk('2026-11-24', '18:00'), holidays: ['2026-11-23'] });
    expect(r.warnings[0].details).toMatchObject({ givenDays: 2 });
  });

  it('never warns for an XS task (same day) and rejects a deadline in the past', () => {
    expect(checkDeadline({ ...base, size: 'XS', neededDays: 0, deadline: pk(MON, '12:00') }).warnings).toEqual([]);
    const past = checkDeadline({ ...base, deadline: pk('2026-11-13', '18:00') });
    expect(past.errors.map((e) => e.code)).toContain('deadline_in_past');
    expect(past.errors[0].message).toBe("A deadline can't be in the past.");
    expect(past.warnings).toEqual([]);
  });

  it('rejects a deadline before the start date', () => {
    const r = checkDeadline({ ...base, start: pk('2026-11-18'), deadline: pk('2026-11-17', '18:00') });
    expect(r.errors.map((e) => e.code)).toContain('deadline_before_start');
  });

  it('rejects XL: it must be split before it is assigned', () => {
    const r = checkDeadline({ ...base, size: 'XL', neededDays: null, deadline: pk('2026-12-10', '18:00') });
    expect(r.errors.map((e) => e.code)).toEqual(['size_xl_not_assignable']);
  });

  it('a personal to-do skips the size checks but not the date checks', () => {
    expect(checkDeadline({ ...base, size: 'XL', neededDays: null, personal: true, deadline: pk(MON, '18:00') })).toEqual({ errors: [], warnings: [] });
    expect(checkDeadline({ ...base, personal: true, deadline: pk('2026-11-13') }).errors.map((e) => e.code)).toContain('deadline_in_past');
  });

  it('asks for a deadline when it is not a date', () => {
    expect(checkDeadline({ ...base, deadline: new Date('nope') }).errors.map((e) => e.code)).toEqual(['deadline_required']);
  });

  it('works out the working days given', () => {
    expect(givenWorkingDays(pk(MON), pk('2026-11-19', '18:00'))).toBe(3);
    expect(givenWorkingDays(pk(MON), pk(MON, '18:00'))).toBe(0);
  });

  it('does not count the start day, also when it is a Saturday, a Sunday or a holiday', () => {
    // Saturday 14 start: Monday 16 is the first working day after it, so a Monday deadline gives 1 day.
    expect(givenWorkingDays(pk('2026-11-14'), pk(MON, '18:00'))).toBe(1);
    expect(givenWorkingDays(pk('2026-11-15'), pk(MON, '18:00'))).toBe(1);
    // A start on a holiday Monday: Tuesday and Wednesday are given.
    expect(givenWorkingDays(pk(MON), pk('2026-11-18', '18:00'), ['2026-11-16'])).toBe(2);
    // A deadline equal to the suggested one never raises a too-short warning, whatever the start day.
    for (const start of ['2026-11-13', '2026-11-14', '2026-11-15', MON]) {
      const from = pk(start, '10:00');
      for (const days of [1, 3, 7]) {
        const deadline = suggestedDeadline(from, days) as Date;
        expect(givenWorkingDays(from, deadline)).toBeGreaterThanOrEqual(days);
      }
    }
  });
});

describe('on time, extensions and manager changes', () => {
  it('on time means handed in at or before the approved deadline', () => {
    const deadline = pk('2026-11-19', '18:00');
    expect(isOnTime(deadline, deadline)).toBe(true);
    expect(isOnTime(new Date(deadline.getTime() + 1), deadline)).toBe(false);
    expect(isOnTime(pk('2026-11-18'), deadline)).toBe(true);
  });

  it('an extension request before the deadline is on time, after it counts as late', () => {
    const current = pk('2026-11-19', '18:00');
    const requested = pk('2026-11-23', '18:00');
    expect(checkExtension({ currentDeadline: current, requestedDeadline: requested, now: pk('2026-11-18') })).toEqual({ errors: [], late: false });
    expect(checkExtension({ currentDeadline: current, requestedDeadline: requested, now: pk('2026-11-20') })).toEqual({ errors: [], late: true });
  });

  it('a late extension never turns a late task into an on-time one: the deadline before the late request is the one measured', () => {
    const due = pk('2026-11-10', '18:00');
    const extendedTo = pk('2026-11-15', '18:00');
    const submitted = pk('2026-11-14', '12:00'); // after the first deadline, before the extended one
    // no late request: the (moved) deadline in force is the one measured (an extension approved before the deadline is not late)
    expect(isOnTime(submitted, timelinessDeadline(extendedTo, []))).toBe(true);
    // one late request, asked when the deadline was the 10th: measured against the 10th, so late
    expect(isOnTime(submitted, timelinessDeadline(extendedTo, [due]))).toBe(false);
    // handed in before the first deadline: on time even though a late extension was asked afterwards
    expect(isOnTime(pk('2026-11-10', '17:00'), timelinessDeadline(extendedTo, [due]))).toBe(true);
  });

  it('with an in-time extension first and a late one after it, the late request is measured from the deadline it was asked at', () => {
    const first = pk('2026-11-12', '18:00'); // moved from the 10th, asked on time
    const last = pk('2026-11-17', '18:00'); // asked on the 13th (late), approved
    expect(timelinessDeadline(last, [first])).toEqual(first);
    // several late requests: the earliest deadline wins; the current deadline is never a later one than itself
    expect(timelinessDeadline(last, [pk('2026-11-15', '18:00'), first])).toEqual(first);
    expect(timelinessDeadline(first, [last])).toEqual(first);
  });

  it('an extension must ask for a later date than the current deadline, in the future', () => {
    const current = pk('2026-11-19', '18:00');
    expect(checkExtension({ currentDeadline: current, requestedDeadline: current, now: NOW }).errors[0].code).toBe('extension_not_later');
    expect(checkExtension({ currentDeadline: current, requestedDeadline: pk('2026-11-18'), now: NOW }).errors[0].code).toBe('extension_not_later');
    // Asked after the deadline for a date that is already over too
    const stale = checkExtension({ currentDeadline: pk('2026-11-10'), requestedDeadline: pk('2026-11-12'), now: NOW });
    expect(stale.errors[0].code).toBe('deadline_in_past');
    expect(stale.late).toBe(true);
  });

  it('extensions are possible while the person is working on it (and while on hold), not once it is handed in or closed', () => {
    for (const s of ['assigned', 'in_progress', 'rework', 'on_hold']) expect(canRequestExtensionIn(s)).toBe(true);
    for (const s of ['submitted', 'under_review', 'approved', 'cancelled']) expect(canRequestExtensionIn(s)).toBe(false);
  });

  it('a manager changing the deadline needs a reason, a real change and a future date', () => {
    const current = pk('2026-11-19', '18:00');
    expect(checkDeadlineChange({ current, next: pk('2026-11-23', '18:00'), now: NOW, reason: 'Client moved the launch' })).toEqual([]);
    expect(checkDeadlineChange({ current, next: pk('2026-11-18', '18:00'), now: NOW, reason: 'Needed earlier' })).toEqual([]);
    expect(checkDeadlineChange({ current, next: pk('2026-11-23'), now: NOW, reason: '' }).map((e) => e.code)).toEqual(['reason_required']);
    expect(checkDeadlineChange({ current, next: pk('2026-11-23'), now: NOW, reason: undefined }).map((e) => e.code)).toEqual(['reason_required']);
    expect(checkDeadlineChange({ current, next: current, now: NOW, reason: 'Same' }).map((e) => e.code)).toEqual(['deadline_unchanged']);
    expect(checkDeadlineChange({ current, next: pk('2026-11-13'), now: NOW, reason: 'Oops' }).map((e) => e.code)).toEqual(['deadline_in_past']);
  });
});
