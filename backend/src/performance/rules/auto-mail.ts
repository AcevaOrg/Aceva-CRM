/**
 * The words of the Module 6 mails (plan section 10): the reviewer's "drafts are waiting", the employee's "your scorecard is
 * ready" and "your dispute was decided", and the decider's "a rating is disputed". Pure functions: they build the subject,
 * the plain text and the HTML twin; sending, addresses and lookups live in performance-mail.service.ts.
 *
 * Mails are short and plain, name the month and the task number, and carry a link. They never hold a secret or a pay figure,
 * and NEVER the score itself (the screen shows it; a mail can be forwarded). The ratings of a disputed task (1 to 5) are not the score.
 */
import { escapeHtml, excerpt, type MailText } from '../../tasks/rules/auto-mail';

export type { MailText };

interface Layout {
  subject: string;
  name: string;
  /** The sentences, one paragraph each. */
  paragraphs: string[];
  link: string;
  linkLabel: string;
}

function build(l: Layout): MailText {
  const text = [`Hello ${l.name},`, '', ...l.paragraphs.flatMap((p) => [p, '']), `${l.linkLabel}: ${l.link}`, ''].join('\n');
  const html =
    `<p>Hello ${escapeHtml(l.name)},</p>` +
    l.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('') +
    `<p><a href="${escapeHtml(l.link)}">${escapeHtml(l.linkLabel)}</a></p>`;
  return { subject: l.subject, text, html };
}

/** "1 draft scorecard" / "5 draft scorecards". */
export const draftsPhrase = (count: number): string => `${count} draft scorecard${count === 1 ? '' : 's'}`;

/**
 * After the monthly run: ONE mail to a reviewer for all the drafts waiting for them ("You have 5 draft scorecards for October
 * 2026 to review and release"). `month` is the label ("October 2026").
 */
export function draftsWaitingMail(i: { name: string; month: string; count: number; link: string }): MailText {
  return build({
    subject: `${draftsPhrase(i.count)} to review: ${i.month}`,
    name: i.name,
    paragraphs: [
      `You have ${draftsPhrase(i.count)} for ${i.month} to review and release.`,
      'Each one was made from the reviewed tasks of the month. You can add a remark before you release it. The numbers cannot be changed, and the person sees their scorecard only after you release it.',
    ],
    link: i.link,
    linkLabel: 'Open the approvals inbox',
  });
}

/**
 * The employee's scorecard was released: by the reviewer, or by the system when the person has no reviewer (`releasedBy`
 * null, the Director's). No score in the text.
 */
export function releasedMail(i: { name: string; month: string; releasedBy: string | null; link: string }): MailText {
  return build({
    subject: `Your ${i.month} scorecard is ready`,
    name: i.name,
    paragraphs: [
      i.releasedBy ? `${i.releasedBy} released your scorecard for ${i.month}.` : `Your scorecard for ${i.month} was released.`,
      'Open it to see how the month went. You can acknowledge it, add a comment, and dispute the rating of a task if you think it is wrong.',
    ],
    link: i.link,
    linkLabel: 'Open the scorecard',
  });
}

/** The decider is told that a rating was disputed (with the employee's reason). */
export function disputeRaisedMail(i: { name: string; employee: string; number: string; month: string; rating: number; reason: string | null; link: string }): MailText {
  const reason = i.reason?.trim();
  return build({
    subject: `Rating disputed: ${i.number}`,
    name: i.name,
    paragraphs: [
      `${i.employee} disputes the rating of ${i.number} on their ${i.month} scorecard. The task was rated ${i.rating} out of 5.`,
      ...(reason ? [`Reason: "${excerpt(reason)}"`] : []),
      'Please look at it again, then keep the rating or change it.',
    ],
    link: i.link,
    linkLabel: 'Open the scorecard',
  });
}

/**
 * The employee is told how the dispute ended: the rating was kept, or changed from X to Y (and the scorecard was worked out
 * again with the weights it was made with). `decision` is the note the decider wrote.
 */
export function disputeDecidedMail(i: {
  name: string;
  decidedBy: string;
  number: string;
  month: string;
  decision: 'upheld' | 'changed';
  ratingBefore: number;
  ratingAfter: number | null;
  note: string | null;
  link: string;
}): MailText {
  const note = i.note?.trim();
  const changed = i.decision === 'changed' && i.ratingAfter !== null;
  return build({
    subject: changed ? `Rating changed: ${i.number}` : `Rating kept: ${i.number}`,
    name: i.name,
    paragraphs: [
      changed
        ? `${i.decidedBy} looked at your dispute of ${i.number} on your ${i.month} scorecard and changed the rating from ${i.ratingBefore} to ${i.ratingAfter} out of 5. Your scorecard was worked out again with the same weights it was made with.`
        : `${i.decidedBy} looked at your dispute of ${i.number} on your ${i.month} scorecard and kept the rating of ${i.ratingBefore} out of 5.`,
      ...(note ? [`Note: "${excerpt(note)}"`] : []),
    ],
    link: i.link,
    linkLabel: 'Open the scorecard',
  });
}
