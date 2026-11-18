import { describe, expect, it } from 'vitest';
import {
  HANDOVER_CLOSED_ASSIGNER,
  HANDOVER_CLOSED_NO_REVIEWER,
  HANDOVER_CLOSED_NOT_BELOW,
  HANDOVER_CLOSED_VIEW_ONLY,
  handoverOutcome,
  pickHandoverTarget,
  seriesHandoverOutcome,
} from './auto-handover';
import {
  assignedMail,
  escapeHtml,
  excerpt,
  extensionDecidedMail,
  extensionRequestedMail,
  handoverClosedMail,
  handoverMail,
  mentionMail,
  reminderMail,
  reviewWaitingMail,
  statusMail,
} from './auto-mail';
import {
  isTooLate,
  LATE_TOLERANCE_MS,
  OVERDUE_LATE_TOLERANCE_MS,
  reminderJobKey,
  reminderKindPrefix,
  repeatJobKey,
  repeatKeyPrefix,
  resolveReminderRecipients,
} from './auto-reminders';
import { taskReminderKeyPrefix, taskRepeatKey } from './task-reminders';

/** A moment in Pakistan time. */
const pk = (day: string, time = '09:00') => new Date(`${day}T${time}:00+05:00`);

describe('reminder job keys', () => {
  it('half time, 24 hours before and the deadline have ONE job per task and kind', () => {
    expect(reminderJobKey('t1', 'half_time', pk('2026-11-18'))).toBe('task.reminder:t1:half_time');
    expect(reminderJobKey('t1', 'day_before', pk('2026-11-18'))).toBe('task.reminder:t1:day_before');
    expect(reminderJobKey('t1', 'deadline', pk('2026-11-18'))).toBe('task.reminder:t1:deadline');
  });

  it('every daily overdue notice is its own job (a handler cannot re-arm its own row), named by the Pakistan day', () => {
    expect(reminderJobKey('t1', 'overdue', pk('2026-11-20'))).toBe('task.reminder:t1:overdue:2026-11-20');
    expect(reminderJobKey('t1', 'overdue', pk('2026-11-21'))).toBe('task.reminder:t1:overdue:2026-11-21');
    // 09:00 Pakistan time is 04:00 UTC: the same calendar day in both
    expect(reminderJobKey('t1', 'overdue', new Date('2026-11-20T04:00:00Z'))).toBe('task.reminder:t1:overdue:2026-11-20');
  });

  it('all of a task\'s keys start with its prefix, and a kind prefix never matches another kind', () => {
    const prefix = taskReminderKeyPrefix('t1');
    for (const kind of ['half_time', 'day_before', 'deadline', 'overdue'] as const) expect(reminderJobKey('t1', kind, pk('2026-11-20')).startsWith(prefix)).toBe(true);
    expect(reminderJobKey('t1', 'overdue', pk('2026-11-20')).startsWith(reminderKindPrefix('t1', 'overdue'))).toBe(true);
    expect(reminderJobKey('t1', 'deadline', pk('2026-11-20')).startsWith(reminderKindPrefix('t1', 'overdue'))).toBe(false);
    expect(reminderJobKey('t10', 'deadline', pk('2026-11-20')).startsWith(prefix)).toBe(false);
  });

  it('a repeating series has one job per occurrence day', () => {
    expect(repeatJobKey('r1', '2026-11-23')).toBe(`${taskRepeatKey('r1')}:2026-11-23`);
    expect(repeatJobKey('r1', '2026-11-23').startsWith(repeatKeyPrefix('r1'))).toBe(true);
    expect(repeatJobKey('r10', '2026-11-23').startsWith(repeatKeyPrefix('r1'))).toBe(false);
  });
});

describe('a reminder that runs too late is not sent', () => {
  const planned = pk('2026-11-18', '18:00');
  it('on time, or a few minutes after a retry: sent', () => {
    expect(isTooLate('day_before', planned, planned)).toBe(false);
    expect(isTooLate('deadline', planned, new Date(planned.getTime() + 30 * 60_000))).toBe(false);
    expect(isTooLate('half_time', planned, new Date(planned.getTime() + LATE_TOLERANCE_MS))).toBe(false);
  });

  it('after the server was down: dropped (a "due in 24 hours" mail after the deadline would mislead)', () => {
    expect(isTooLate('day_before', planned, new Date(planned.getTime() + LATE_TOLERANCE_MS + 1))).toBe(true);
    expect(isTooLate('deadline', planned, new Date(planned.getTime() + 6 * 3_600_000))).toBe(true);
  });

  it('the daily overdue notice tolerates a long delay, but not a whole day', () => {
    expect(isTooLate('overdue', planned, new Date(planned.getTime() + 10 * 3_600_000))).toBe(false);
    expect(isTooLate('overdue', planned, new Date(planned.getTime() + OVERDUE_LATE_TOLERANCE_MS + 1))).toBe(true);
  });
});

describe('who gets a reminder', () => {
  const dev = { empId: 'ACV-0006', left: false };
  const cto = { empId: 'ACV-0004', left: false };
  const director = { empId: 'ACV-0003', left: false };

  it('half time, 24 hours before and the deadline go to the person doing the task alone', () => {
    for (const kind of ['half_time', 'day_before', 'deadline'] as const) expect(resolveReminderRecipients(kind, dev, cto, cto)).toEqual(['ACV-0006']);
  });

  it('the overdue notice also goes to the assigner and to the assignee\'s manager, never twice to the same person', () => {
    expect(resolveReminderRecipients('overdue', dev, cto, cto)).toEqual(['ACV-0006', 'ACV-0004']);
    expect(resolveReminderRecipients('overdue', dev, director, cto)).toEqual(['ACV-0006', 'ACV-0003', 'ACV-0004']);
  });

  it('people who left get nothing; when the assigner left the manager still hears about it', () => {
    expect(resolveReminderRecipients('overdue', dev, { ...director, left: true }, cto)).toEqual(['ACV-0006', 'ACV-0004']);
    expect(resolveReminderRecipients('overdue', dev, cto, null)).toEqual(['ACV-0006', 'ACV-0004']);
    expect(resolveReminderRecipients('deadline', { ...dev, left: true }, cto, cto)).toEqual([]);
  });
});

describe('leaver hand-over decisions', () => {
  const manager = { id: 'cto-uuid', roleKey: 'cto' };

  it('an open task moves to the manager', () => {
    expect(handoverOutcome({ assignedById: 'director-uuid' }, manager)).toEqual({ outcome: 'move' });
  });

  it('a task the manager assigned himself is closed (nobody reviews their own task)', () => {
    expect(handoverOutcome({ assignedById: 'cto-uuid' }, manager)).toEqual({ outcome: 'close', reason: HANDOVER_CLOSED_ASSIGNER });
  });

  it('a task that would land on the view-only CEO / Founder / Owner is closed too', () => {
    expect(handoverOutcome({ assignedById: 'someone' }, { id: 'owner-uuid', roleKey: 'owner' })).toEqual({ outcome: 'close', reason: HANDOVER_CLOSED_VIEW_ONLY });
  });

  it('finished work waiting for its reviewer is never closed: it stays with the person who did it', () => {
    expect(handoverOutcome({ assignedById: 'cto-uuid', status: 'submitted' }, manager)).toEqual({ outcome: 'keep' });
    expect(handoverOutcome({ assignedById: 'cto-uuid', status: 'under_review' }, manager)).toEqual({ outcome: 'keep' });
    expect(handoverOutcome({ assignedById: 'x', status: 'submitted' }, { id: 'o', roleKey: 'owner' })).toEqual({ outcome: 'keep' });
    expect(handoverOutcome({ assignedById: 'cto-uuid', status: 'in_progress' }, manager)).toEqual({ outcome: 'close', reason: HANDOVER_CLOSED_ASSIGNER });
    // when the manager can take it, even a handed-in task moves with the rest
    expect(handoverOutcome({ assignedById: 'director-uuid', status: 'submitted' }, manager)).toEqual({ outcome: 'move' });
  });

  it('a repeating series moves, or stops when the new owner could not take its tasks', () => {
    expect(seriesHandoverOutcome({ assignedById: 'director-uuid' }, manager)).toBe('move');
    expect(seriesHandoverOutcome({ assignedById: 'cto-uuid' }, manager)).toBe('stop');
    expect(seriesHandoverOutcome({ assignedById: 'x' }, { id: 'o', roleKey: 'owner' })).toBe('stop');
  });

  it('work never moves up the line: a new owner who is not below the assigner closes it (or keeps it, when it is handed in)', () => {
    const director = { id: 'director-uuid', roleKey: 'director' }; // above the CTO who assigned the work
    const notBelow = { belowAssigner: false };
    expect(handoverOutcome({ assignedById: 'cto-uuid', status: 'in_progress' }, director, notBelow)).toEqual({ outcome: 'close', reason: HANDOVER_CLOSED_NOT_BELOW });
    expect(handoverOutcome({ assignedById: 'cto-uuid', status: 'assigned' }, director, notBelow)).toEqual({ outcome: 'close', reason: HANDOVER_CLOSED_NOT_BELOW });
    expect(handoverOutcome({ assignedById: 'cto-uuid', status: 'submitted' }, director, notBelow)).toEqual({ outcome: 'keep' });
    expect(handoverOutcome({ assignedById: 'cto-uuid', status: 'under_review' }, director, notBelow)).toEqual({ outcome: 'keep' });
    // a new owner who IS below the assigner still gets it
    expect(handoverOutcome({ assignedById: 'director-uuid' }, manager, { belowAssigner: true, hasReviewer: true })).toEqual({ outcome: 'move' });
    // ...unless nobody could review it for him
    expect(handoverOutcome({ assignedById: 'director-uuid' }, manager, { belowAssigner: true, hasReviewer: false })).toEqual({ outcome: 'close', reason: HANDOVER_CLOSED_NO_REVIEWER });
    // the older reasons come first
    expect(handoverOutcome({ assignedById: 'cto-uuid' }, manager, notBelow)).toEqual({ outcome: 'close', reason: HANDOVER_CLOSED_ASSIGNER });
    expect(handoverOutcome({ assignedById: 'x' }, { id: 'o', roleKey: 'owner' }, notBelow)).toEqual({ outcome: 'close', reason: HANDOVER_CLOSED_VIEW_ONLY });
  });

  it('a repeating series stops when it would move to someone who is not below the person who set it up', () => {
    const director = { id: 'director-uuid', roleKey: 'director' };
    expect(seriesHandoverOutcome({ assignedById: 'cto-uuid' }, director, { belowAssigner: false })).toBe('stop');
    expect(seriesHandoverOutcome({ assignedById: 'cto-uuid' }, director, { belowAssigner: true, hasReviewer: false })).toBe('stop');
    expect(seriesHandoverOutcome({ assignedById: 'director-uuid' }, manager, { belowAssigner: true, hasReviewer: true })).toBe('move');
  });

  it('the person named in the event takes over; when they left too, the nearest manager above who has not', () => {
    const a = { id: 'a', status: 'active' };
    const b = { id: 'b', status: 'left' };
    const c = { id: 'c', status: 'active' };
    expect(pickHandoverTarget(a, [c])).toBe(a);
    expect(pickHandoverTarget(b, [{ id: 'x', status: 'left' }, c])).toBe(c);
    expect(pickHandoverTarget(b, [{ id: 'x', status: 'left' }])).toBeNull();
    expect(pickHandoverTarget({ id: 'n', status: 'on_notice' }, [c])?.id).toBe('n');
  });
});

describe('the mail texts', () => {
  const link = 'http://localhost:3000/tasks/abc';
  const deadline = pk('2026-11-19', '18:00');

  it('escapes text for the HTML twin and cuts long comments', () => {
    expect(escapeHtml('<b>"A" & \'B\'</b>')).toBe('&lt;b&gt;&quot;A&quot; &amp; &#39;B&#39;&lt;/b&gt;');
    expect(excerpt('short')).toBe('short');
    expect(excerpt('x'.repeat(400)).length).toBe(303);
    expect(excerpt('x'.repeat(400)).endsWith('...')).toBe(true);
    expect(excerpt('  padded  ')).toBe('padded');
  });

  it('the assignment mail names the assigner, the task, the size and the deadline in Pakistan time, with a link', () => {
    const m = assignedMail({ name: 'Mariam', assigner: 'Hamza', number: 'TSK-0142', title: 'Fix login', size: 'M', priority: 'high', deadline, repeating: false, link });
    expect(m.subject).toBe('New task TSK-0142: Fix login');
    expect(m.text).toContain('Hello Mariam,');
    expect(m.text).toContain('Hamza assigned you TSK-0142 "Fix login"');
    expect(m.text).toContain('Size: M, priority high');
    expect(m.text).toContain('19 Nov 2026, 18:00 (Pakistan time)');
    expect(m.text).toContain(link);
    expect(m.html).toContain(`<a href="${link}">`);
    expect(assignedMail({ name: 'M', assigner: 'H', number: 'TSK-1', title: 't', size: 'S', deadline, repeating: true, link }).text).toContain('repeating task');
  });

  it('each reminder says plainly what is happening', () => {
    const base = { name: 'Mariam', assigneeName: 'Mariam Shah', forAssignee: true, number: 'TSK-0142', title: 'Fix login', deadline, link };
    expect(reminderMail({ ...base, kind: 'half_time' })).toMatchObject({ subject: 'Half the time has passed: TSK-0142' });
    expect(reminderMail({ ...base, kind: 'half_time' }).text).toContain('has not been started');
    expect(reminderMail({ ...base, kind: 'day_before' })).toMatchObject({ subject: 'Due in 24 hours: TSK-0142' });
    expect(reminderMail({ ...base, kind: 'deadline' })).toMatchObject({ subject: 'Due now: TSK-0142' });
    const overdue = reminderMail({ ...base, kind: 'overdue' });
    expect(overdue.subject).toBe('Overdue: TSK-0142');
    expect(overdue.text).toContain('is overdue');
    expect(overdue.text).toContain('Deadline: 19 Nov 2026, 18:00 (Pakistan time)');
  });

  it('the manager\'s copy of an overdue notice names the person who is late', () => {
    const m = reminderMail({ kind: 'overdue', name: 'Hamza', assigneeName: 'Mariam Shah', forAssignee: false, number: 'TSK-0142', title: 'Fix login', deadline, link });
    expect(m.text).toContain('TSK-0142 "Fix login" (Mariam Shah) is overdue');
  });

  it('a mention mail shows who wrote it and the start of the comment, and escapes it in the HTML', () => {
    const m = mentionMail({ name: 'Mariam', author: 'Hamza', number: 'TSK-0142', title: 'Fix login', comment: 'Please look at <this>', link });
    expect(m.subject).toBe('Hamza mentioned you on TSK-0142');
    expect(m.text).toContain('"Please look at <this>"');
    expect(m.html).toContain('Please look at &lt;this&gt;');
    expect(m.html).not.toContain('<this>');
  });

  it('review, approval, rework, hold and cancel mails', () => {
    expect(reviewWaitingMail({ name: 'Hamza', assignee: 'Mariam', number: 'TSK-1', title: 't', link }).subject).toBe('Waiting for your review: TSK-1');
    const approved = statusMail({ name: 'Mariam', by: 'Hamza', number: 'TSK-1', title: 't', to: 'approved', rating: 4, reason: 'Nice work', link });
    expect(approved.subject).toBe('Approved: TSK-1');
    expect(approved.text).toContain('rating of 4 out of 5');
    expect(approved.text).toContain('Comment: "Nice work"');
    expect(statusMail({ name: 'M', by: 'H', number: 'TSK-1', title: 't', to: 'approved', link }).text).not.toContain('rating');
    expect(statusMail({ name: 'M', by: 'H', number: 'TSK-1', title: 't', to: 'rework', reason: 'Missing tests', link }).text).toContain('Reason: "Missing tests"');
    expect(statusMail({ name: 'M', by: 'H', number: 'TSK-1', title: 't', to: 'on_hold', reason: 'Client paused', link }).text).toContain('no reminders');
    expect(statusMail({ name: 'M', by: 'H', number: 'TSK-1', title: 't', to: 'cancelled', reason: 'No longer needed', link }).subject).toBe('Cancelled: TSK-1');
  });

  it('extension mails: the request goes to the assigner, the decision to the person who asked', () => {
    const asked = extensionRequestedMail({ name: 'Hamza', requester: 'Mariam', number: 'TSK-1', title: 't', currentDeadline: deadline, requestedDeadline: pk('2026-11-23', '18:00'), reason: 'Waiting on the client', late: false, link });
    expect(asked.subject).toBe('Extension asked: TSK-1');
    expect(asked.text).toContain('Asked for: 23 Nov 2026, 18:00 (Pakistan time)');
    expect(asked.text).not.toContain('after the deadline');
    expect(extensionRequestedMail({ name: 'H', requester: 'M', number: 'TSK-1', title: 't', currentDeadline: deadline, requestedDeadline: pk('2026-11-23', '18:00'), reason: 'r', late: true, link }).text).toContain('after the deadline had passed');
    const ok = extensionDecidedMail({ name: 'Mariam', decider: 'Hamza', number: 'TSK-1', title: 't', approved: true, newDeadline: pk('2026-11-23', '18:00'), reason: null, link });
    expect(ok.subject).toBe('Extension approved: TSK-1');
    expect(ok.text).toContain('New deadline: 23 Nov 2026, 18:00');
    const no = extensionDecidedMail({ name: 'Mariam', decider: 'Hamza', number: 'TSK-1', title: 't', approved: false, newDeadline: null, reason: 'Too late', link });
    expect(no.subject).toBe('Extension not approved: TSK-1');
    expect(no.text).toContain('Reason: "Too late"');
    expect(no.text).toContain('The deadline stays');
  });

  it('no mail holds a pay figure or a secret: only the task facts', () => {
    const all = [
      assignedMail({ name: 'a', assigner: 'b', number: 'TSK-1', title: 't', size: 'M', deadline, repeating: false, link }),
      reminderMail({ kind: 'deadline', name: 'a', assigneeName: 'a', forAssignee: true, number: 'TSK-1', title: 't', deadline, link }),
    ];
    for (const m of all) expect(m.text + m.html).not.toMatch(/salary|password|token/i);
  });
});

describe('hand-over mails', () => {
  const link = 'https://app.example/tasks';
  const task = (n: number, reason?: string) => ({ number: `TSK-${String(n).padStart(4, '0')}`, title: `Task ${n}`, ...(reason ? { reason } : {}) });

  it('tells the new owner what moved, what was closed and why, what waits for review and what happened to the repeating tasks', () => {
    const mail = handoverMail({
      name: 'Omar',
      leaver: 'Mariam Shah',
      moved: [task(1), task(2)],
      closed: [task(3, 'Closed on hand-over: the assigner takes over')],
      kept: [task(4)],
      seriesMoved: 1,
      seriesStopped: 2,
      link,
    });
    expect(mail.subject).toBe('Mariam Shah has left: their open tasks');
    expect(mail.text).toContain('Hello Omar,');
    expect(mail.text).toContain('Moved to you (2):');
    expect(mail.text).toContain('TSK-0001 "Task 1"');
    expect(mail.text).toContain('Closed (1):');
    expect(mail.text).toContain('TSK-0003 "Task 3" (the assigner takes over)'); // the history prefix is cut
    expect(mail.text).not.toContain('Closed on hand-over: the assigner takes over');
    expect(mail.text).toContain('still waiting for review');
    expect(mail.text).toContain('Repeating tasks that now belong to you: 1');
    expect(mail.text).toContain('Repeating tasks that were stopped: 2');
    expect(mail.text).toContain(`Open the tasks: ${link}`);
    expect(mail.html).toContain('<a href="https://app.example/tasks">');
  });

  it('leaves out the parts that are empty, and counts instead of listing a very long list', () => {
    const only = handoverMail({ name: 'Omar', leaver: 'Mariam Shah', moved: [task(1)], closed: [], kept: [], seriesMoved: 0, seriesStopped: 0, link });
    expect(only.text).toContain('Moved to you (1):');
    expect(only.text).not.toContain('Closed');
    expect(only.text).not.toContain('Repeating');
    const many = handoverMail({ name: 'Omar', leaver: 'Mariam Shah', moved: Array.from({ length: 20 }, (_, i) => task(i + 1)), closed: [], kept: [], seriesMoved: 0, seriesStopped: 0, link });
    expect(many.text).toContain('Moved to you (20):');
    expect(many.text).toContain('TSK-0015');
    expect(many.text).not.toContain('TSK-0016');
    expect(many.text).toContain('and 5 more');
  });

  it('tells the person who assigned them which tasks were closed, and never puts markup from a title into the HTML', () => {
    const mail = handoverClosedMail({ name: 'Omar', leaver: 'Mariam Shah', newOwner: 'Bilal Ahmed', closed: [{ number: 'TSK-0009', title: '<b>Fix</b>', reason: 'Closed on hand-over: the new owner is not below the person who assigned it' }], link });
    expect(mail.subject).toBe('Tasks you assigned to Mariam Shah were closed');
    expect(mail.text).toContain('could not move to Bilal Ahmed');
    expect(mail.text).toContain('(the new owner is not below the person who assigned it)');
    expect(mail.html).not.toContain('<b>Fix</b>');
    expect(mail.html).toContain('&lt;b&gt;Fix&lt;/b&gt;');
  });
});
