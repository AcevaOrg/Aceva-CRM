import { dec, type Decimal } from '../common/money';

/**
 * Which level must approve a journal entry (plan section 13). Pure, so it is unit-tested on its own.
 *
 *  - The tier is the one whose max amount covers the PKR total, checking the tiers from the lowest authority up
 *    (decision D25 defaults: level 3 Director up to 5,000,000 and level 1 Owner with no limit; there is no CEO tier.
 *    Stored in `approval_limits`; the Owner sets the real values, D22).
 *  - Any line on a share capital or loan account (`requires_owner_approval`) needs level 1, the Owner.
 *  - "If that approver made the entry, it goes one level up": when the maker's own level number is the required level or
 *    higher authority, the entry needs the level above the maker (maker level - 1). Nobody above level 1 = nobody can approve.
 *    So an entry the Director made needs level 2, the CEO: since D25 the only entries the CEO approves.
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
  return LEVEL_NAMES[level] ?? `Level ${level}`;
}

/** Names for levels without a tier of their own (since D25 the CEO has no tier, but approves entries the Director made). */
const LEVEL_NAMES: Record<number, string> = { 1: 'Owner', 2: 'CEO', 3: 'Director' };

/**
 * May a person at `approverLevel` approve an entry that needs `requiredLevel`? Decision D25: only at exactly that level, or
 * the Owner (level 1), who may approve any entry. The CEO (level 2) therefore approves only entries that need level 2, that
 * is the ones the Director made, and never the Director's everyday approvals.
 */
export function levelCovers(approverLevel: number, requiredLevel: number): boolean {
  return approverLevel === requiredLevel || approverLevel === 1;
}
