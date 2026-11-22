/**
 * The words of the task mails (plan section 9, "Reminders" and "Comments with @mentions"). Pure functions: they build the
 * subject, the plain text and the HTML twin; sending, addresses and lookups live in task-mail.service.ts.
 *
 * Mails are short and plain, name the task by its number and carry a link to it. They never hold a secret or a pay figure.
 */
import type { ReminderKind } from './task-reminders';
import { formatPkDateTime } from './task-format';

export interface MailText {
  subject: string;
  text: string;
  html: string;
}

/** Escapes text for the HTML twin. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The first `max` characters of a comment, with "..." when it was cut. */
export function excerpt(body: string, max = 300): string {
  const clean = body.trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}...` : clean;
}

interface Layout {
  subject: string;
  name: string;
  /** The sentences, one paragraph each. */
  paragraphs: string[];
  /** Extra lines under the paragraphs (for example the deadline). */
  facts?: string[];
  link: string;
  linkLabel?: string;
}

function build(l: Layout): MailText {
  const facts = l.facts ?? [];
  const text = [`Hello ${l.name},`, '', ...l.paragraphs.flatMap((p) => [p, '']), ...(facts.length ? [...facts, ''] : []), `${l.linkLabel ?? 'Open the task'}: ${l.link}`, ''].join('\n');
  const html =
    `<p>Hello ${escapeHtml(l.name)},</p>` +
    l.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('') +
    (facts.length ? `<p>${facts.map(escapeHtml).join('<br>')}</p>` : '') +
    `<p><a href="${escapeHtml(l.link)}">${escapeHtml(l.linkLabel ?? 'Open the task')}</a></p>`;
  return { subject: l.subject, text, html };
}

/** "<assigner> assigned you <number> <title>". */
export function assignedMail(i: { name: string; assigner: string; number: string; title: string; size: string; priority?: string; deadline: Date; repeating: boolean; link: string }): MailText {
  const how = i.repeating ? ' It comes from a repeating task.' : '';
  return build({
    subject: `New task ${i.number}: ${i.title}`,
    name: i.name,
    paragraphs: [`${i.assigner} assigned you ${i.number} "${i.title}".${how}`],
    facts: [`Size: ${i.size}${i.priority ? `, priority ${i.priority}` : ''}`, `Deadline: ${formatPkDateTime(i.deadline)} (Pakistan time)`],
    link: i.link,
  });
}

/**
 * A reminder. `forAssignee` is false for the manager's copy of an overdue notice (it names the person doing the task).
 * Plain words: "TSK-0142 is due in 24 hours".
 */
export function reminderMail(i: { kind: ReminderKind; name: string; assigneeName: string; forAssignee: boolean; number: string; title: string; deadline: Date; link: string }): MailText {
  const when = `${formatPkDateTime(i.deadline)} (Pakistan time)`;
  const who = i.forAssignee ? '' : ` (${i.assigneeName})`;
  let subject: string;
  let line: string;
  switch (i.kind) {
    case 'half_time':
      subject = `Half the time has passed: ${i.number}`;
      line = `Half of the time for ${i.number} "${i.title}" has passed and it has not been started.`;
      break;
    case 'day_before':
      subject = `Due in 24 hours: ${i.number}`;
      line = `${i.number} "${i.title}"${who} is due in 24 hours.`;
      break;
    case 'deadline':
      subject = `Due now: ${i.number}`;
      line = `${i.number} "${i.title}"${who} is due now.`;
      break;
    case 'overdue':
      subject = `Overdue: ${i.number}`;
      line = `${i.number} "${i.title}"${who} is overdue.`;
      break;
  }
  return build({ subject, name: i.name, paragraphs: [line], facts: [`Deadline: ${when}`], link: i.link });
}

/** "<author> mentioned you on <number>" with the start of the comment. */
export function mentionMail(i: { name: string; author: string; number: string; title: string; comment: string; link: string }): MailText {
  return build({
    subject: `${i.author} mentioned you on ${i.number}`,
    name: i.name,
    paragraphs: [`${i.author} mentioned you in a comment on ${i.number} "${i.title}":`, `"${excerpt(i.comment)}"`],
    link: i.link,
  });
}

/** "<number> is waiting for your review". */
export function reviewWaitingMail(i: { name: string; assignee: string; number: string; title: string; link: string }): MailText {
  return build({
    subject: `Waiting for your review: ${i.number}`,
    name: i.name,
    paragraphs: [`${i.assignee} handed in ${i.number} "${i.title}". It is waiting for your review.`],
    link: i.link,
  });
}

/** What the person doing the task hears when the reviewer or the assigner acts on it. */
export function statusMail(i: { name: string; by: string; number: string; title: string; to: 'approved' | 'rework' | 'on_hold' | 'cancelled'; rating?: number | null; reason?: string | null; link: string }): MailText {
  const reason = i.reason?.trim();
  switch (i.to) {
    case 'approved':
      return build({
        subject: `Approved: ${i.number}`,
        name: i.name,
        paragraphs: [`${i.by} approved ${i.number} "${i.title}"${i.rating ? ` with a rating of ${i.rating} out of 5` : ''}.`, ...(reason ? [`Comment: "${excerpt(reason)}"`] : [])],
        link: i.link,
      });
    case 'rework':
      return build({
        subject: `Sent back for rework: ${i.number}`,
        name: i.name,
        paragraphs: [`${i.by} sent ${i.number} "${i.title}" back for rework.`, ...(reason ? [`Reason: "${excerpt(reason)}"`] : [])],
        link: i.link,
      });
    case 'on_hold':
      return build({
        subject: `Put on hold: ${i.number}`,
        name: i.name,
        paragraphs: [`${i.by} put ${i.number} "${i.title}" on hold. You get no reminders for it until it is resumed.`, ...(reason ? [`Reason: "${excerpt(reason)}"`] : [])],
        link: i.link,
      });
    case 'cancelled':
      return build({
        subject: `Cancelled: ${i.number}`,
        name: i.name,
        paragraphs: [`${i.by} cancelled ${i.number} "${i.title}".`, ...(reason ? [`Reason: "${excerpt(reason)}"`] : [])],
        link: i.link,
      });
  }
}

/** An extension was asked for: goes to the assigner. */
export function extensionRequestedMail(i: { name: string; requester: string; number: string; title: string; currentDeadline: Date; requestedDeadline: Date; reason: string; late: boolean; link: string }): MailText {
  return build({
    subject: `Extension asked: ${i.number}`,
    name: i.name,
    paragraphs: [`${i.requester} asked for more time on ${i.number} "${i.title}"${i.late ? ' after the deadline had passed' : ''}.`, `Reason: "${excerpt(i.reason)}"`],
    facts: [`Current deadline: ${formatPkDateTime(i.currentDeadline)}`, `Asked for: ${formatPkDateTime(i.requestedDeadline)} (Pakistan time)`],
    link: i.link,
    linkLabel: 'Decide the request',
  });
}

/** The decision on an extension: goes to the person who asked. */
export function extensionDecidedMail(i: { name: string; decider: string; number: string; title: string; approved: boolean; newDeadline: Date | null; reason: string | null; link: string }): MailText {
  const reason = i.reason?.trim();
  if (i.approved) {
    return build({
      subject: `Extension approved: ${i.number}`,
      name: i.name,
      paragraphs: [`${i.decider} approved your request for more time on ${i.number} "${i.title}".`],
      facts: i.newDeadline ? [`New deadline: ${formatPkDateTime(i.newDeadline)} (Pakistan time)`] : [],
      link: i.link,
    });
  }
  return build({
    subject: `Extension not approved: ${i.number}`,
    name: i.name,
    paragraphs: [`${i.decider} did not approve your request for more time on ${i.number} "${i.title}". The deadline stays.`, ...(reason ? [`Reason: "${excerpt(reason)}"`] : [])],
    link: i.link,
  });
}

/** One task in a hand-over mail. `reason` is the history line of a task that was closed. */
export interface HandoverMailTask {
  number: string;
  title: string;
  reason?: string;
}

/** The most tasks a hand-over mail lists by name; the rest are counted. */
const MAX_LISTED = 15;

/** A heading and one line per task ("TSK-0142 "Fix login" (the assigner takes over)"), cut after MAX_LISTED. */
function taskLines(heading: string, tasks: HandoverMailTask[]): string[] {
  if (tasks.length === 0) return [];
  const lines = tasks.slice(0, MAX_LISTED).map((t) => `${t.number} "${t.title}"${t.reason ? ` (${t.reason.replace(/^Closed on hand-over: /, '')})` : ''}`);
  if (tasks.length > MAX_LISTED) lines.push(`and ${tasks.length - MAX_LISTED} more`);
  return [`${heading} (${tasks.length}):`, ...lines];
}

/**
 * What the new owner is told when a leaver's work is handed over to them: what moved to them, what was closed (and why),
 * what stays with the leaver until it is reviewed, and the repeating tasks. One mail per leaver.
 */
export function handoverMail(i: { name: string; leaver: string; moved: HandoverMailTask[]; closed: HandoverMailTask[]; kept: HandoverMailTask[]; seriesMoved: number; seriesStopped: number; link: string }): MailText {
  const series = [...(i.seriesMoved ? [`Repeating tasks that now belong to you: ${i.seriesMoved}`] : []), ...(i.seriesStopped ? [`Repeating tasks that were stopped: ${i.seriesStopped}`] : [])];
  return build({
    subject: `${i.leaver} has left: their open tasks`,
    name: i.name,
    paragraphs: [
      `${i.leaver} has left the company. Their open tasks were handed over to you.`,
      ...(i.closed.length ? ['A task you assigned yourself, or one that would not stay below the person who assigned it, is closed instead of moved.'] : []),
    ],
    facts: [...taskLines('Moved to you', i.moved), ...taskLines('Closed', i.closed), ...taskLines('Handed in, still waiting for review (it stays with the person who did it)', i.kept), ...series],
    link: i.link,
    linkLabel: 'Open the tasks',
  });
}

/** What the person who assigned them is told when tasks they assigned to a leaver could not move to the new owner and were closed. */
export function handoverClosedMail(i: { name: string; leaver: string; newOwner: string; closed: HandoverMailTask[]; link: string }): MailText {
  return build({
    subject: `Tasks you assigned to ${i.leaver} were closed`,
    name: i.name,
    paragraphs: [`${i.leaver} has left the company. The tasks below, which you assigned, could not move to ${i.newOwner}, so they were closed. You can assign the work again.`],
    facts: taskLines('Closed', i.closed),
    link: i.link,
    linkLabel: 'Open the tasks',
  });
}
