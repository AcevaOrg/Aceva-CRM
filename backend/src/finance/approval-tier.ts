import { dec, type Decimal } from '../common/money';

/**
 * Which level must approve a journal entry (final company structure, decision D26). Pure, so it is unit-tested on its own.
 *
 *  - The Director (level 2) approves every entry, whatever the amount. A "confirm again" with password and code applies
 *    above the confirm-again amount in the finance settings (journal.service.ts).
 *  - "If that approver made the entry, it goes one level up": when the maker's own level number is the required level or a
 *    higher authority, the entry needs the level above the maker (maker level - 1). So an entry the Director made needs the
 *    CEO / Founder / Owner (level 1), and an entry the Owner made has nobody above (no_eligible_approver).
 *  - The Owner approves ONLY those entries (exact level match). Otherwise the Owner only views: a large entry or a
 *    capital or loan entry does not wait for the Owner, it is reported to the Owner (ownerNotice).
 */
export const OWNER_LEVEL = 1;
export const DIRECTOR_LEVEL = 2;

export type TierResult = { ok: true; level: number; label: string } | { ok: false; reason: 'no_eligible_approver' };

export function requiredApprovalLevel(makerLevel: number | null): TierResult {
  let level = DIRECTOR_LEVEL;
  if (makerLevel !== null && makerLevel <= level) level = makerLevel - 1;
  if (level < OWNER_LEVEL) return { ok: false, reason: 'no_eligible_approver' };
  return { ok: true, level, label: labelFor(level) };
}

export function labelFor(level: number): string {
  if (level === OWNER_LEVEL) return 'CEO / Founder / Owner';
  if (level === DIRECTOR_LEVEL) return 'Director';
  return `Level ${level}`;
}

/** May a person at `approverLevel` approve an entry that needs `requiredLevel`? Only at exactly that level. */
export function levelCovers(approverLevel: number, requiredLevel: number): boolean {
  return approverLevel === requiredLevel;
}

export type OwnerNotice = 'capital_or_loan' | 'large_amount';

/**
 * Entries the Owner is told about (view only, they do not wait for the Owner): any line on a share capital or loan account
 * (`requires_owner_approval`, a flag that now means "report to the Owner"), or a total strictly above the notify amount.
 */
export function ownerNotice(totalBase: Decimal, notifyAbove: Decimal, touchesFlaggedAccount: boolean): OwnerNotice | null {
  if (touchesFlaggedAccount) return 'capital_or_loan';
  if (dec(totalBase).greaterThan(notifyAbove)) return 'large_amount';
  return null;
}
