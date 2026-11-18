/**
 * The size table (plan section 9, "Task sizes"). Pure functions: no Nest, no database.
 * The defaults here match the rows the migration inserts into task_size_settings.
 */
import { TASK_SIZES, type SizeRuleView, type TaskSizeName, type UpdateSizeRuleRequest } from '@aceva/contracts';
import type { TaskIssue } from './task-deadlines';

export type SizeRule = SizeRuleView;

export const DEFAULT_SIZE_RULES: readonly SizeRule[] = [
  { size: 'XS', meaning: 'Very small, such as fixing a typo', hours: 2, hoursLabel: 'Up to 2 h', points: 1, days: 0 },
  { size: 'S', meaning: 'Small', hours: 4, hoursLabel: '2 to 4 h', points: 2, days: 1 },
  { size: 'M', meaning: 'Medium', hours: 16, hoursLabel: '1 to 2 days', points: 3, days: 3 },
  { size: 'L', meaning: 'Large', hours: 40, hoursLabel: '3 to 5 days', points: 5, days: 7 },
  { size: 'XL', meaning: 'Very large', hours: 48, hoursLabel: 'More than 1 week', points: 0, days: null },
];

export const sizeOrder = (size: TaskSizeName): number => TASK_SIZES.indexOf(size);

export function ruleFor(rules: readonly SizeRule[], size: TaskSizeName): SizeRule {
  const rule = rules.find((r) => r.size === size);
  if (!rule) throw new Error(`No size rule for ${size}`);
  return rule;
}

/** Applies a Director's change to one row. XL keeps "must be split" (no days). Returns the new row. */
export function applySizeUpdate(current: SizeRule, patch: Omit<UpdateSizeRuleRequest, 'reason'>): SizeRule {
  return {
    size: current.size,
    meaning: patch.meaning ?? current.meaning,
    hours: patch.hours ?? current.hours,
    hoursLabel: patch.hoursLabel ?? current.hoursLabel,
    points: patch.points ?? current.points,
    days: current.size === 'XL' ? null : (patch.days ?? current.days),
  };
}

/**
 * Sanity checks on the whole table after a change: XL can never get suggested days (it must be split), and a bigger size
 * never has fewer hours, points or working days than a smaller one (XS <= S <= M <= L). XL points stay 0 (not scored).
 */
export function checkSizeTable(rules: readonly SizeRule[]): TaskIssue[] {
  const issues: TaskIssue[] = [];
  const sorted = [...rules].sort((a, b) => sizeOrder(a.size) - sizeOrder(b.size));
  for (const r of sorted) {
    if (r.size === 'XL' && r.days !== null) issues.push({ code: 'xl_days', message: 'XL tasks must be split: they cannot have suggested days.' });
    if (r.size !== 'XL' && r.days === null) issues.push({ code: 'days_required', message: `${r.size} needs suggested working days.` });
    if (r.hours <= 0) issues.push({ code: 'hours_positive', message: `${r.size} needs more than 0 hours.` });
  }
  const scored = sorted.filter((r) => r.size !== 'XL');
  for (let i = 1; i < scored.length; i++) {
    const smaller = scored[i - 1];
    const bigger = scored[i];
    if (bigger.hours < smaller.hours) issues.push({ code: 'hours_order', message: `${bigger.size} cannot have fewer hours than ${smaller.size}.` });
    if (bigger.points < smaller.points) issues.push({ code: 'points_order', message: `${bigger.size} cannot be worth fewer points than ${smaller.size}.` });
    if ((bigger.days ?? 0) < (smaller.days ?? 0)) issues.push({ code: 'days_order', message: `${bigger.size} cannot have fewer suggested days than ${smaller.size}.` });
  }
  return issues;
}

/** The fields that changed between two rows, for the history ("hours 16 -> 20"). */
export function sizeChanges(before: SizeRule, after: SizeRule): Array<{ field: keyof Omit<SizeRule, 'size'>; from: string; to: string }> {
  const fields = ['meaning', 'hours', 'hoursLabel', 'points', 'days'] as const;
  return fields
    .filter((f) => before[f] !== after[f])
    .map((f) => ({ field: f, from: String(before[f] ?? 'none'), to: String(after[f] ?? 'none') }));
}
