import { describe, expect, it } from 'vitest';
import {
  correctionRequestSchema, leaveRequestSchema, leaveTypeRequestSchema, officeNetworkRequestSchema, workScheduleRequestSchema,
} from '@aceva/contracts';
import { averageClock, checkInAllowedFrom, clockOf, ipInCidr, ipv4ToNumber, lateMinutesFor, leaveDaysFor, leaveYearOf, minuteOf } from './attendance-rules';

const schedule = { startMinute: 9 * 60, graceMinutes: 15 };

describe('M7 rules: late flag (start + grace)', () => {
  it('is on time up to and including start + grace, late from the next minute', () => {
    expect(lateMinutesFor(8 * 60 + 30, schedule, true)).toBe(0); // before the start
    expect(lateMinutesFor(9 * 60, schedule, true)).toBe(0);
    expect(lateMinutesFor(9 * 60 + 15, schedule, true)).toBe(0); // exactly 09:15
    expect(lateMinutesFor(9 * 60 + 16, schedule, true)).toBe(1); // 09:16
    expect(lateMinutesFor(11 * 60, schedule, true)).toBe(105);
  });
  it('is never late on a day that is not a working day', () => {
    expect(lateMinutesFor(13 * 60, schedule, false)).toBe(0);
  });
  it('formats and parses clock times', () => {
    expect(clockOf(555)).toBe('09:15');
    expect(minuteOf('18:00')).toBe(1080);
    expect(averageClock([9 * 60, 9 * 60 + 30])).toBe('09:15');
    expect(averageClock([])).toBeNull();
  });
});

describe('M7 rules: office-only check-in', () => {
  it('matches single IPv4 addresses and CIDR ranges', () => {
    expect(ipv4ToNumber('10.0.0.1')).toBe(167772161);
    expect(ipv4ToNumber('::ffff:10.0.0.1')).toBe(167772161);
    expect(ipv4ToNumber('300.1.1.1')).toBeNull();
    expect(ipv4ToNumber('::1')).toBeNull();
    expect(ipInCidr('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(ipInCidr('203.0.113.8', '203.0.113.7')).toBe(false);
    expect(ipInCidr('203.0.113.200', '203.0.113.0/24')).toBe(true);
    expect(ipInCidr('203.0.114.1', '203.0.113.0/24')).toBe(false);
    expect(ipInCidr('10.20.30.40', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('1.2.3.4', '0.0.0.0/0')).toBe(true);
    expect(ipInCidr(null, '10.0.0.0/8')).toBe(false);
  });
  it('restricts only when switched on AND the office has networks', () => {
    expect(checkInAllowedFrom('1.1.1.1', false, ['10.0.0.0/8'])).toBe(true);
    expect(checkInAllowedFrom('1.1.1.1', true, [])).toBe(true); // e.g. the Remote office
    expect(checkInAllowedFrom('1.1.1.1', true, ['10.0.0.0/8'])).toBe(false);
    expect(checkInAllowedFrom('10.1.1.1', true, ['192.168.0.0/16', '10.0.0.0/8'])).toBe(true);
  });
});

describe('M7 rules: leave days', () => {
  it('counts working days, a half day is 0.5 of a single working day', () => {
    expect(leaveDaysFor(3, false)).toBe(3);
    expect(leaveDaysFor(1, true)).toBe(0.5);
    expect(leaveDaysFor(0, true)).toBe(0);
    expect(leaveDaysFor(0, false)).toBe(0);
    expect(leaveYearOf('2027-12-31')).toBe(2027);
  });
});

describe('M7 contracts: request schemas', () => {
  it('correction: needs a time and a reason; check-out not before check-in', () => {
    expect(correctionRequestSchema.safeParse({ date: '2027-03-02', checkIn: '09:05', reason: 'Forgot to check in' }).success).toBe(true);
    expect(correctionRequestSchema.safeParse({ date: '2027-03-02', reason: 'Forgot to check in' }).success).toBe(false);
    expect(correctionRequestSchema.safeParse({ date: '2027-03-02', checkIn: '09:05', reason: 'no' }).success).toBe(false);
    expect(correctionRequestSchema.safeParse({ date: '2027-03-02', checkIn: '18:00', checkOut: '09:00', reason: 'Swapped times' }).success).toBe(false);
    expect(correctionRequestSchema.safeParse({ date: '2027-3-2', checkIn: '09:05', reason: 'Forgot to check in' }).success).toBe(false);
    expect(correctionRequestSchema.safeParse({ date: '2027-03-02', checkIn: '24:00', reason: 'Forgot to check in' }).success).toBe(false);
  });
  it('leave: dates in order, half day only on one day', () => {
    const id = '3f1c6a52-3b8e-4c55-9c0d-2c6a1f9f1a01';
    expect(leaveRequestSchema.safeParse({ leaveTypeId: id, from: '2027-05-03', to: '2027-05-04', reason: 'Family' }).success).toBe(true);
    expect(leaveRequestSchema.safeParse({ leaveTypeId: id, from: '2027-05-04', to: '2027-05-03', reason: 'Family' }).success).toBe(false);
    expect(leaveRequestSchema.safeParse({ leaveTypeId: id, from: '2027-05-03', to: '2027-05-04', halfDay: true, reason: 'Family' }).success).toBe(false);
    expect(leaveRequestSchema.safeParse({ leaveTypeId: 'casual', from: '2027-05-03', to: '2027-05-03', reason: 'Family' }).success).toBe(false);
    expect(leaveRequestSchema.safeParse({ leaveTypeId: id, from: '2027-05-03', to: '2027-05-03', reason: '' }).success).toBe(false);
  });
  it('settings: schedule hours, leave types, office networks', () => {
    const base = { effectiveFrom: '2027-04-01', start: '09:00', end: '18:00', graceMinutes: 15, workingWeekdays: [1, 2, 3, 4, 5], reason: 'Summer hours' };
    expect(workScheduleRequestSchema.safeParse(base).success).toBe(true);
    expect(workScheduleRequestSchema.safeParse({ ...base, end: '08:00' }).success).toBe(false);
    expect(workScheduleRequestSchema.safeParse({ ...base, workingWeekdays: [] }).success).toBe(false);
    expect(workScheduleRequestSchema.safeParse({ ...base, workingWeekdays: [1, 1] }).success).toBe(false);
    expect(workScheduleRequestSchema.safeParse({ ...base, workingWeekdays: [8] }).success).toBe(false);
    expect(workScheduleRequestSchema.safeParse({ ...base, reason: 'x' }).success).toBe(false);
    expect(leaveTypeRequestSchema.safeParse({ key: 'maternity', name: 'Maternity', yearlyDays: 90, paid: true, reason: 'Company policy' }).success).toBe(true);
    expect(leaveTypeRequestSchema.safeParse({ key: 'maternity', name: 'Maternity', yearlyDays: 1.3, paid: true, reason: 'Company policy' }).success).toBe(false);
    expect(leaveTypeRequestSchema.safeParse({ key: 'Bad Key', name: 'Maternity', yearlyDays: null, paid: true, reason: 'Company policy' }).success).toBe(false);
    expect(officeNetworkRequestSchema.safeParse({ officeCode: 'off-khi', cidr: '203.0.113.0/24', reason: 'Karachi office line' }).success).toBe(true);
    expect(officeNetworkRequestSchema.safeParse({ officeCode: 'off-khi', cidr: '203.0.113.0/33', reason: 'Karachi office line' }).success).toBe(false);
    expect(officeNetworkRequestSchema.safeParse({ officeCode: 'off-khi', cidr: 'fe80::1', reason: 'Karachi office line' }).success).toBe(false);
  });
});
