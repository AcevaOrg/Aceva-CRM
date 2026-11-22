/**
 * "Changes" in activity search (plan section 8: old value and new value of every edited field).
 *
 * Decision: the old and new values are NOT copied into the activity tables. Every request gets a request id; the
 * audit log rows a request writes carry that id (AuditService fills it in automatically), and the activity event of
 * the same request carries it too. Activity search joins the two and turns the audit row's details into field changes:
 *   - details { before: {...}, after: {...} }  ->  one change per field whose value differs (Modules 1, 5, 6...)
 *   - details { fields: ['Phone', ...] }        ->  the changed field names only; the values stay in the profile
 *                                                  history (Module 3 keeps them there, encrypted where sensitive)
 * New modules get the diff in activity search for free by writing { before, after } in their audit details.
 * Never put secrets or pay amounts in before/after.
 */

export interface FieldDiff {
  field: string;
  from: string;
  to: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function show(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** reportsTo -> "Reports to", head -> "Head". */
export function fieldLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function changesFromAudit(details: unknown): FieldDiff[] {
  if (!isRecord(details)) return [];
  const before = isRecord(details.before) ? details.before : null;
  const after = isRecord(details.after) ? details.after : null;
  if (before || after) {
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
    return keys
      .map((key) => ({ field: fieldLabel(key), from: show(before?.[key]), to: show(after?.[key]) }))
      .filter((c) => c.from !== c.to);
  }
  if (Array.isArray(details.fields)) {
    return details.fields.filter((f): f is string => typeof f === 'string' && f.length > 0).map((field) => ({ field, from: '', to: 'changed' }));
  }
  return [];
}
