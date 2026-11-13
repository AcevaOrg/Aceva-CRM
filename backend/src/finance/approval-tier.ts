import { dec, type Decimal } from '../common/money';

/**
 * Which level must approve a journal entry (plan section 13). Pure, so it is unit-tested on its own.
 *
 *  - The tier is the one whose max amount covers the PKR total, checking the tiers from the lowest authority up
 *    (level 3 Director up to 50,000, level 2 CEO up to 500,000, level 1 Owner with no limit: the plan's EXAMPLE values,
 *    stored in `approval_limits`; management sets the real ones).
 *  - Any line on a share capital or loan account (`requires_owner_approval`) needs level 1, the Owner.
 *  - "If that approver made the entry, it goes one level up": when the maker's own level number is the required level or
 *    higher authority, the entry needs the level above the maker (maker level - 1). Nobody above level 1 = nobody can approve.
 */
export interface Tier {
  approverLevel: number;
  /** Null = no upper limit. */
  maxAmount: Decimal | null;
  label: string;
}

export type TierResult = { ok: true; level: number; label: string } | { ok: false; reason: 'no_tier' | 'no_eligible_approver' };

export function requiredApprovalLevel(totalBase: Decimal, tiers: Tier[], touchesOwnerAccount: boolean, makerLevel: number | null): TierResult {
  const ordered = [...tiers].sort((a, b) => b.approverLevel - a.approverLevel); // least authority first
  let level: number | null = null;
  if (touchesOwnerAccount) level = 1;
  else {
    const tier = ordered.find((t) => t.maxAmount === null || dec(totalBase).lessThanOrEqualTo(t.maxAmount));
    level = tier?.approverLevel ?? null;
  }
  if (level === null) return { ok: false, reason: 'no_tier' };
  if (makerLevel !== null && makerLevel <= level) level = makerLevel - 1;
  if (level < 1) return { ok: false, reason: 'no_eligible_approver' };
  return { ok: true, level, label: labelFor(level, tiers) };
}

export function labelFor(level: number, tiers: Tier[]): string {
  const exact = tiers.find((t) => t.approverLevel === level);
  if (exact) return exact.label.replace(/\s*\(.*\)\s*$/, '');
  return `Level ${level}`;
}

/** May a person at `approverLevel` approve an entry that needs `requiredLevel`? (a lower number is more authority) */
export function levelCovers(approverLevel: number, requiredLevel: number): boolean {
  return approverLevel <= requiredLevel;
}
