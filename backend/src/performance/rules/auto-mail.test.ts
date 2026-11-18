import { describe, expect, it } from 'vitest';
import { disputeDecidedMail, disputeRaisedMail, draftsPhrase, draftsWaitingMail, releasedMail } from './auto-mail';

const LINK = 'http://localhost:3000/performance/scorecards/6f0c2c3e-1111-4222-8333-444455556666';

describe('drafts waiting (to the reviewer)', () => {
  it('says how many drafts of which month wait, links to the approvals inbox, and never holds a score', () => {
    const m = draftsWaitingMail({ name: 'Omar Farooq', month: 'October 2026', count: 5, link: 'http://localhost:3000/approvals' });
    expect(m.subject).toBe('5 draft scorecards to review: October 2026');
    expect(m.text).toContain('Hello Omar Farooq,');
    expect(m.text).toContain('You have 5 draft scorecards for October 2026 to review and release.');
    expect(m.text).toContain('Open the approvals inbox: http://localhost:3000/approvals');
    expect(m.html).toContain('<a href="http://localhost:3000/approvals">Open the approvals inbox</a>');
    expect(m.text).not.toMatch(/score:|points|%/i);
  });

  it('one draft is singular', () => {
    expect(draftsPhrase(1)).toBe('1 draft scorecard');
    expect(draftsPhrase(2)).toBe('2 draft scorecards');
    expect(draftsWaitingMail({ name: 'A', month: 'March 2027', count: 1, link: 'x' }).subject).toBe('1 draft scorecard to review: March 2027');
  });

  it('tells the reviewer the numbers cannot be changed and the person sees it only after release', () => {
    const m = draftsWaitingMail({ name: 'A', month: 'October 2026', count: 2, link: 'x' });
    expect(m.text).toContain('The numbers cannot be changed');
    expect(m.text).toContain('after you release it');
  });
});

describe('released (to the employee)', () => {
  it('names who released it, the month, the link and what the person can do', () => {
    const m = releasedMail({ name: 'Mariam Shah', month: 'October 2026', releasedBy: 'Omar Farooq', link: LINK });
    expect(m.subject).toBe('Your October 2026 scorecard is ready');
    expect(m.text).toContain('Omar Farooq released your scorecard for October 2026.');
    expect(m.text).toContain('acknowledge it, add a comment, and dispute the rating of a task');
    expect(m.text).toContain(`Open the scorecard: ${LINK}`);
  });

  it('the Director\'s automatic release has no releaser', () => {
    const m = releasedMail({ name: 'Bilal Ahmed', month: 'October 2026', releasedBy: null, link: LINK });
    expect(m.text).toContain('Your scorecard for October 2026 was released.');
    expect(m.text).not.toContain('null');
    expect(m.text).not.toContain('undefined');
  });

  it('escapes names and links in the HTML twin', () => {
    const m = releasedMail({ name: 'A <b>&"', month: 'October 2026', releasedBy: null, link: 'http://x/?a=1&b=2' });
    expect(m.html).toContain('Hello A &lt;b&gt;&amp;&quot;,');
    expect(m.html).toContain('href="http://x/?a=1&amp;b=2"');
    expect(m.html).not.toContain('<b>');
  });
});

describe('dispute raised (to the decider)', () => {
  it('names the employee, the task, the rating and the reason', () => {
    const m = disputeRaisedMail({ name: 'Bilal Ahmed', employee: 'Mariam Shah', number: 'TSK-0142', month: 'October 2026', rating: 2, reason: 'The spec changed after I started.', link: LINK });
    expect(m.subject).toBe('Rating disputed: TSK-0142');
    expect(m.text).toContain('Mariam Shah disputes the rating of TSK-0142 on their October 2026 scorecard. The task was rated 2 out of 5.');
    expect(m.text).toContain('Reason: "The spec changed after I started."');
    expect(m.text).toContain('keep the rating or change it');
    expect(m.text).toContain(LINK);
  });

  it('a long reason is cut and a missing reason is left out', () => {
    const long = disputeRaisedMail({ name: 'B', employee: 'M', number: 'TSK-1', month: 'October 2026', rating: 3, reason: 'x'.repeat(500), link: LINK });
    expect(long.text).toContain('...');
    expect(long.text.length).toBeLessThan(700);
    const none = disputeRaisedMail({ name: 'B', employee: 'M', number: 'TSK-1', month: 'October 2026', rating: 3, reason: null, link: LINK });
    expect(none.text).not.toContain('Reason:');
  });
});

describe('dispute decided (to the employee)', () => {
  const base = { name: 'Mariam Shah', decidedBy: 'Omar Farooq', number: 'TSK-0142', month: 'October 2026', link: LINK };

  it('upheld: the rating is kept, no recompute is promised', () => {
    const m = disputeDecidedMail({ ...base, decision: 'upheld', ratingBefore: 2, ratingAfter: null, note: 'The scope was in the brief.' });
    expect(m.subject).toBe('Rating kept: TSK-0142');
    expect(m.text).toContain('kept the rating of 2 out of 5');
    expect(m.text).toContain('Note: "The scope was in the brief."');
    expect(m.text).not.toContain('worked out again');
  });

  it('changed: says from X to Y and that the scorecard was worked out again with the same weights', () => {
    const m = disputeDecidedMail({ ...base, decision: 'changed', ratingBefore: 2, ratingAfter: 4, note: 'You were right.' });
    expect(m.subject).toBe('Rating changed: TSK-0142');
    expect(m.text).toContain('changed the rating from 2 to 4 out of 5');
    expect(m.text).toContain('worked out again with the same weights it was made with');
  });

  it('never holds a score (the screen shows it)', () => {
    const m = disputeDecidedMail({ ...base, decision: 'changed', ratingBefore: 2, ratingAfter: 4, note: null });
    expect(m.text).not.toMatch(/score (was|is) \d|\d+(\.\d)? points/i);
    expect(m.text).not.toContain('Note:');
  });
});
