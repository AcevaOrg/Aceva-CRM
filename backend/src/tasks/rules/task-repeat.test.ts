import { describe, expect, it } from 'vitest';
import {
  describeRepeat,
  dueOccurrences,
  isFinished,
  nextOccurrence,
  occurrenceDayOf,
  occurrenceRunAt,
  occurrenceWindow,
  occursOn,
  pakistanTimeOfDay,
  templateTiming,
  type RepeatRule,
} from './task-repeat';

/** 2026-11-16 is a Monday. */
const everyMonday: RepeatRule = { every: 'week', on: 1 };
const fifth: RepeatRule = { every: 'month', on: 5 };

describe('which days a series falls on', () => {
  it('weekly: the chosen weekday (1 = Monday)', () => {
    expect(occursOn(everyMonday, '2026-11-16')).toBe(true);
    expect(occursOn(everyMonday, '2026-11-17')).toBe(false);
    expect(occursOn({ every: 'week', on: 5 }, '2026-11-20')).toBe(true);
    expect(occursOn({ every: 'week', on: 7 }, '2026-11-22')).toBe(true);
  });

  it('monthly: the chosen day of the month', () => {
    expect(occursOn(fifth, '2026-12-05')).toBe(true);
    expect(occursOn(fifth, '2026-12-06')).toBe(false);
  });
});

describe('the next occurrence', () => {
  it('weekly: the next Monday, never the day itself', () => {
    expect(nextOccurrence(everyMonday, '2026-11-16')).toBe('2026-11-23');
    expect(nextOccurrence(everyMonday, '2026-11-17')).toBe('2026-11-23');
    expect(nextOccurrence(everyMonday, '2026-11-22')).toBe('2026-11-23');
    expect(nextOccurrence(everyMonday, '2026-12-28')).toBe('2027-01-04');
  });

  it('monthly: the same day next month, across the year end', () => {
    expect(nextOccurrence(fifth, '2026-11-05')).toBe('2026-12-05');
    expect(nextOccurrence(fifth, '2026-11-01')).toBe('2026-11-05');
    expect(nextOccurrence(fifth, '2026-12-31')).toBe('2027-01-05');
    expect(nextOccurrence({ every: 'month', on: 28 }, '2027-01-28')).toBe('2027-02-28');
  });

  it('stops after the stop date, but that day itself is still made', () => {
    const rule: RepeatRule = { every: 'week', on: 1, until: '2026-11-30' };
    expect(nextOccurrence(rule, '2026-11-16')).toBe('2026-11-23');
    expect(nextOccurrence(rule, '2026-11-23')).toBe('2026-11-30');
    expect(nextOccurrence(rule, '2026-11-30')).toBeNull();
    expect(nextOccurrence({ ...rule, until: '2026-11-29' }, '2026-11-23')).toBeNull();
    expect(isFinished(rule, '2026-11-30')).toBe(true);
    expect(isFinished(rule, '2026-11-23')).toBe(false);
    expect(isFinished(everyMonday, '2026-11-23')).toBe(false);
  });
});

describe('occurrences that are due', () => {
  it('lists the days after the last one up to today, today included', () => {
    expect(dueOccurrences(everyMonday, '2026-11-09', '2026-11-16')).toEqual(['2026-11-16']);
    expect(dueOccurrences(everyMonday, '2026-11-09', '2026-11-15')).toEqual([]);
    expect(dueOccurrences(everyMonday, '2026-11-16', '2026-11-16')).toEqual([]);
  });

  it('after downtime keeps only the newest ones (default 3), oldest first', () => {
    expect(dueOccurrences(everyMonday, '2026-10-12', '2026-11-16')).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
    expect(dueOccurrences(everyMonday, '2026-10-12', '2026-11-16', 2)).toEqual(['2026-11-09', '2026-11-16']);
    expect(dueOccurrences(everyMonday, '2026-10-12', '2026-11-16', 1)).toEqual(['2026-11-16']);
  });

  it('never goes past the stop date', () => {
    expect(dueOccurrences({ every: 'week', on: 1, until: '2026-11-09' }, '2026-10-26', '2026-11-30')).toEqual(['2026-11-02', '2026-11-09']);
  });

  it('works for a monthly series', () => {
    expect(dueOccurrences(fifth, '2026-09-05', '2026-11-16')).toEqual(['2026-10-05', '2026-11-05']);
  });
});

describe('the task made for an occurrence', () => {
  it('starts at the same time of day and runs as long as the first task (Pakistan time)', () => {
    const timing = templateTiming(new Date('2026-11-16T04:00:00Z'), new Date('2026-11-16T13:00:00Z'));
    expect(timing).toEqual({ startTime: '09:00', durationMinutes: 540 });
    const w = occurrenceWindow('2026-11-23', timing);
    expect(w.start.toISOString()).toBe('2026-11-23T04:00:00.000Z');
    expect(w.deadline.toISOString()).toBe('2026-11-23T13:00:00.000Z');
  });

  it('a multi-day task keeps its length', () => {
    const timing = templateTiming(new Date('2026-11-16T04:00:00Z'), new Date('2026-11-19T13:00:00Z'));
    expect(timing.durationMinutes).toBe(3 * 1440 + 540);
    expect(occurrenceWindow('2026-11-23', timing).deadline.toISOString()).toBe('2026-11-26T13:00:00.000Z');
  });

  it('reads the Pakistan time of day and day of an instant', () => {
    expect(pakistanTimeOfDay(new Date('2026-11-16T19:30:00Z'))).toBe('00:30');
    expect(occurrenceDayOf(new Date('2026-11-16T19:30:00Z'))).toBe('2026-11-17');
    expect(occurrenceDayOf(new Date('2026-11-16T04:00:00Z'))).toBe('2026-11-16');
  });

  it('is made five minutes after midnight Pakistan time on the day', () => {
    expect(occurrenceRunAt('2026-11-23').toISOString()).toBe('2026-11-22T19:05:00.000Z');
  });

  it('is described in plain words', () => {
    expect(describeRepeat(everyMonday)).toBe('Every Monday');
    expect(describeRepeat({ every: 'week', on: 5, until: '2026-12-31' })).toBe('Every Friday, until 2026-12-31');
    expect(describeRepeat(fifth)).toBe('On day 5 of every month');
  });
});
