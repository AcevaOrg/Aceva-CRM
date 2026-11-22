import { describe, expect, it } from 'vitest';
import {
  kindAppliesTo,
  nextOverdueAt,
  reminderRecipients,
  reminderSchedule,
  stillApplies,
  taskReminderKey,
  taskReminderKeyPrefix,
  taskRepeatKey,
  type ReminderTask,
} from './task-reminders';

/** A moment in Pakistan time. 2026-11-16 is a Monday. */
const pk = (day: string, time = '09:00') => new Date(`${day}T${time}:00+05:00`);
const iso = (d: Date) => d.toISOString();

// Starts Monday 09:00, deadline Thursday 18:00: 81 hours, half time is Wednesday 01:30.
const task: ReminderTask = { status: 'assigned', personal: false, startDate: pk('2026-11-16'), deadline: pk('2026-11-19', '18:00'), startedAt: null };
const kinds = (t: ReminderTask, now: Date) => reminderSchedule(t, now).map((r) => r.kind);

describe('when the reminders are due', () => {
  it('a task not started yet gets all four: half time, 24 hours before, the deadline, then the first overdue notice', () => {
    const s = reminderSchedule(task, pk('2026-11-16'));
    expect(s.map((r) => [r.kind, iso(r.at)])).toEqual([
      ['half_time', iso(pk('2026-11-18', '01:30'))],
      ['day_before', iso(pk('2026-11-18', '18:00'))],
      ['deadline', iso(pk('2026-11-19', '18:00'))],
      ['overdue', iso(pk('2026-11-20', '09:00'))],
    ]);
  });

  it('a task that was started has no half-time reminder', () => {
    expect(kinds({ ...task, status: 'in_progress', startedAt: pk('2026-11-16', '10:00') }, pk('2026-11-16', '10:00'))).toEqual(['day_before', 'deadline', 'overdue']);
  });

  it('a rework task (the person is fixing it) still gets the deadline reminders', () => {
    expect(kinds({ ...task, status: 'rework', startedAt: pk('2026-11-16', '10:00') }, pk('2026-11-17'))).toEqual(['day_before', 'deadline', 'overdue']);
  });

  it('reminders whose time has passed are not back-filled', () => {
    expect(kinds(task, pk('2026-11-18', '12:00'))).toEqual(['day_before', 'deadline', 'overdue']);
    expect(kinds(task, pk('2026-11-19', '20:00'))).toEqual(['overdue']);
  });

  it('a task that is on hold, handed in, approved or cancelled has none', () => {
    for (const status of ['on_hold', 'submitted', 'under_review', 'approved', 'cancelled'] as const) expect(reminderSchedule({ ...task, status }, pk('2026-11-16'))).toEqual([]);
  });

  it('a personal to-do has none', () => {
    expect(reminderSchedule({ ...task, personal: true }, pk('2026-11-16'))).toEqual([]);
  });

  it('a task shorter than a day has no 24-hours-before reminder', () => {
    const sameDay: ReminderTask = { ...task, startDate: pk('2026-11-16', '09:00'), deadline: pk('2026-11-16', '18:00') };
    expect(reminderSchedule(sameDay, pk('2026-11-16', '08:00')).map((r) => [r.kind, iso(r.at)])).toEqual([
      ['half_time', iso(pk('2026-11-16', '13:30'))],
      ['deadline', iso(pk('2026-11-16', '18:00'))],
      ['overdue', iso(pk('2026-11-17', '09:00'))],
    ]);
  });

  it('moving the deadline moves every reminder (the schedule is worked out from the current deadline)', () => {
    const moved = { ...task, deadline: pk('2026-11-23', '18:00') };
    const s = reminderSchedule(moved, pk('2026-11-17'));
    expect(s.find((r) => r.kind === 'deadline')!.at.toISOString()).toBe(iso(pk('2026-11-23', '18:00')));
    expect(s.find((r) => r.kind === 'day_before')!.at.toISOString()).toBe(iso(pk('2026-11-22', '18:00')));
    expect(s.find((r) => r.kind === 'overdue')!.at.toISOString()).toBe(iso(pk('2026-11-24', '09:00')));
  });
});

describe('the daily overdue notice', () => {
  it('is at 09:00 Pakistan time the day after the deadline, then every day', () => {
    const deadline = pk('2026-11-19', '18:00');
    const first = nextOverdueAt(deadline, deadline);
    expect(iso(first)).toBe(iso(pk('2026-11-20', '09:00')));
    expect(iso(nextOverdueAt(deadline, first))).toBe(iso(pk('2026-11-21', '09:00')));
    expect(iso(nextOverdueAt(deadline, pk('2026-11-25', '10:00')))).toBe(iso(pk('2026-11-26', '09:00')));
  });

  it('a deadline in the small hours is followed by that morning', () => {
    const deadline = pk('2026-11-20', '03:00');
    expect(iso(nextOverdueAt(deadline, deadline))).toBe(iso(pk('2026-11-20', '09:00')));
  });

  it('is never at the same moment it was asked after', () => {
    const at = pk('2026-11-21', '09:00');
    expect(nextOverdueAt(pk('2026-11-19', '18:00'), at).getTime()).toBeGreaterThan(at.getTime());
  });
});

describe('does a reminder still apply when its job runs', () => {
  const armed = task.deadline;
  const running: ReminderTask = { ...task, status: 'in_progress', startedAt: pk('2026-11-16', '10:00') };

  it('which reminder fits which status', () => {
    expect(kindAppliesTo('half_time', 'assigned')).toBe(true);
    expect(kindAppliesTo('half_time', 'in_progress')).toBe(false);
    expect(kindAppliesTo('deadline', 'in_progress')).toBe(true);
    expect(kindAppliesTo('deadline', 'on_hold')).toBe(false);
    expect(kindAppliesTo('overdue', 'submitted')).toBe(false);
  });

  it('applies while the task is waiting on the person, with the deadline it was armed for', () => {
    expect(stillApplies('deadline', running, armed, pk('2026-11-19', '18:00'))).toBe(true);
    expect(stillApplies('day_before', running, armed, pk('2026-11-18', '18:00'))).toBe(true);
    expect(stillApplies('half_time', task, armed, pk('2026-11-18', '01:30'))).toBe(true);
  });

  it('does not apply after the deadline moved, the task was handed in, put on hold, cancelled or approved', () => {
    expect(stillApplies('deadline', { ...running, deadline: pk('2026-11-23', '18:00') }, armed, pk('2026-11-19', '18:00'))).toBe(false);
    for (const status of ['submitted', 'under_review', 'on_hold', 'approved', 'cancelled'] as const) expect(stillApplies('deadline', { ...running, status }, armed, pk('2026-11-19', '18:00'))).toBe(false);
  });

  it('half time is dropped once the task was started', () => {
    expect(stillApplies('half_time', { ...task, startedAt: pk('2026-11-17') }, armed, pk('2026-11-18', '01:30'))).toBe(false);
  });

  it('an overdue notice needs the deadline to be past', () => {
    expect(stillApplies('overdue', running, armed, pk('2026-11-19', '17:00'))).toBe(false);
    expect(stillApplies('overdue', running, armed, pk('2026-11-20', '09:00'))).toBe(true);
  });

  it('a personal to-do never gets one', () => {
    expect(stillApplies('deadline', { ...running, personal: true }, armed, pk('2026-11-19', '18:00'))).toBe(false);
  });
});

describe('who gets the mail and the job keys', () => {
  it('the person doing the task; for an overdue notice also the person who assigned it', () => {
    expect(reminderRecipients('deadline', 'ACV-0007', 'ACV-0004')).toEqual(['ACV-0007']);
    expect(reminderRecipients('half_time', 'ACV-0007', 'ACV-0004')).toEqual(['ACV-0007']);
    expect(reminderRecipients('overdue', 'ACV-0007', 'ACV-0004')).toEqual(['ACV-0007', 'ACV-0004']);
    expect(reminderRecipients('overdue', 'ACV-0007', 'ACV-0007')).toEqual(['ACV-0007']);
  });

  it('one job per task and kind, and the prefix finds them all', () => {
    const id = '7d3f1c9a-2b4e-4a6d-8c1f-0e5a9b7c3d21';
    expect(taskReminderKey(id, 'overdue')).toBe(`task.reminder:${id}:overdue`);
    expect(taskReminderKey(id, 'overdue').startsWith(taskReminderKeyPrefix(id))).toBe(true);
    expect(taskReminderKey(id, 'half_time').startsWith(taskReminderKeyPrefix(id))).toBe(true);
    expect(taskRepeatKey(id)).toBe(`task.repeat:${id}`);
  });
});
