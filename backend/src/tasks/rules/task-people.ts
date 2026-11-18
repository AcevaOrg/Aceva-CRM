/**
 * Who may see a task, and who a comment mentions (plan section 9). Pure functions: the database side (Prisma filters
 * through ScopeService) lives in the services; these are the same rules written once so they can be tested.
 */

export interface TaskParties {
  personal: boolean;
  /** Emp-ID of the person doing it. */
  assignee: string;
  /** Emp-ID of the person who assigned it. */
  assignedBy: string;
}

/**
 * A personal to-do is seen by its owner alone (no manager, not even the CEO / Founder / Owner). A work task is seen by
 * the person doing it, the person who assigned it, and everyone above the assignee in the reporting line (`below` is the
 * set of Emp-IDs below the viewer; the CEO / Founder / Owner's line is the whole company, so he sees every work task).
 */
export function canSeeTask(task: TaskParties, viewer: string, below: ReadonlySet<string>): boolean {
  if (task.personal) return task.assignee === viewer;
  return task.assignee === viewer || task.assignedBy === viewer || below.has(task.assignee);
}

export interface Mentionable {
  empId: string;
  fullName: string;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The people a comment @mentions, as Emp-IDs, in the order they first appear, without repeats. Recognised: the Emp-ID
 * (@ACV-0007), the full name (@Mariam Shah) and the first name (@Mariam, case does not matter). A first name that two
 * people share mentions nobody (the writer must use the full name or the Emp-ID), so a mail never goes to the wrong person.
 * `people` should be the people who may be mentioned (not those who left).
 */
export function extractMentions(body: string, people: readonly Mentionable[]): string[] {
  const firstNameCount = new Map<string, number>();
  for (const p of people) {
    const first = p.fullName.trim().split(/\s+/)[0]?.toLowerCase();
    if (first) firstNameCount.set(first, (firstNameCount.get(first) ?? 0) + 1);
  }
  const found: Array<{ index: number; empId: string }> = [];
  const tokens: Array<{ pattern: string; empId: string }> = [];
  for (const p of people) {
    tokens.push({ pattern: p.empId, empId: p.empId });
    tokens.push({ pattern: escapeRegex(p.fullName.trim()).replace(/\s+/g, '\\s+'), empId: p.empId });
    const first = p.fullName.trim().split(/\s+/)[0];
    if (first && firstNameCount.get(first.toLowerCase()) === 1) tokens.push({ pattern: escapeRegex(first), empId: p.empId });
  }
  for (const t of tokens) {
    // "@" must not be part of a word (an e-mail address is not a mention) and the name must end at a word boundary.
    const re = new RegExp(`(?<![\\w.])@${t.pattern}(?![\\w-])`, 'gi');
    for (const m of body.matchAll(re)) found.push({ index: m.index ?? 0, empId: t.empId });
  }
  found.sort((a, b) => a.index - b.index);
  return [...new Set(found.map((f) => f.empId))];
}
