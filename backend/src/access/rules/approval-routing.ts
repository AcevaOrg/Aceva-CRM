/**
 * Approval routing (plan section 5, "Fixed rules" and "Stand-in approvals", decision C2).
 *
 * The approver is found by walking the person's ACTUAL reporting chain, one position at a time:
 *   requester -> manager -> manager's manager -> ...
 * (not by comparing level numbers).
 *
 * For each position ("seat") in the chain:
 *  1. If the seat holder is not away on the given date, the seat holder approves.
 *  2. If the seat holder is away AND named a stand-in, the stand-in approves
 *     (provided the stand-in is still authorized and is not the requester).
 *  3. If the seat holder is away and named nobody, the request goes one level up.
 *  4. Nobody ever approves their own request: if the approver would be the requester,
 *     the request goes one level up.
 *
 * Pure function: no database, easy to test.
 */

export interface AwayPeriod {
  /** The seat holder (manager) who is away. */
  managerId: string;
  /** Null = away with no stand-in. */
  standInId: string | null;
  /** Inclusive ISO dates (YYYY-MM-DD). */
  startsOn: string;
  endsOn: string;
  /** Revoked periods are ignored. */
  revoked?: boolean;
}

export type SkipReason = 'self' | 'away_no_stand_in' | 'stand_in_is_requester' | 'stand_in_not_authorized';

export interface RoutingInput {
  requesterId: string;
  /** The requester's managers, nearest first: [manager, manager's manager, ...]. */
  chain: string[];
  away: AwayPeriod[];
  /** The date the approval is needed (ISO date). */
  onDate: string;
  /** Continue from the position AFTER this seat (used to move one step further up). */
  afterSeatId?: string | null;
  /** People who may currently act as a stand-in (active and allowed to approve). */
  authorizedStandInIds: ReadonlySet<string>;
}

export interface RoutingResult {
  approverId: string | null;
  seatId: string | null;
  via: 'manager' | 'stand_in' | null;
  skipped: Array<{ seatId: string; reason: SkipReason }>;
}

export function isActiveOn(period: AwayPeriod, isoDate: string): boolean {
  return !period.revoked && period.startsOn <= isoDate && isoDate <= period.endsOn;
}

export function resolveApprover(input: RoutingInput): RoutingResult {
  const { requesterId, chain, away, onDate, afterSeatId, authorizedStandInIds } = input;
  const skipped: RoutingResult['skipped'] = [];

  let start = 0;
  if (afterSeatId) {
    const index = chain.indexOf(afterSeatId);
    start = index === -1 ? chain.length : index + 1;
  }

  for (let i = start; i < chain.length; i++) {
    const seatId = chain[i];
    const period = away.find((p) => p.managerId === seatId && isActiveOn(p, onDate));

    let approverId = seatId;
    let via: 'manager' | 'stand_in' = 'manager';

    if (period) {
      if (!period.standInId) {
        skipped.push({ seatId, reason: 'away_no_stand_in' });
        continue;
      }
      if (period.standInId === requesterId) {
        skipped.push({ seatId, reason: 'stand_in_is_requester' });
        continue;
      }
      if (!authorizedStandInIds.has(period.standInId)) {
        skipped.push({ seatId, reason: 'stand_in_not_authorized' });
        continue;
      }
      approverId = period.standInId;
      via = 'stand_in';
    }

    if (approverId === requesterId) {
      skipped.push({ seatId, reason: 'self' });
      continue;
    }
    return { approverId, seatId, via, skipped };
  }

  return { approverId: null, seatId: null, via: null, skipped };
}

/** Walks the whole route, one step at a time, until nobody is left above. */
export function resolveFullRoute(input: Omit<RoutingInput, 'afterSeatId'>): RoutingResult[] {
  const steps: RoutingResult[] = [];
  let afterSeatId: string | null = null;
  for (let guard = 0; guard <= input.chain.length; guard++) {
    const step = resolveApprover({ ...input, afterSeatId });
    if (!step.approverId) break;
    steps.push(step);
    afterSeatId = step.seatId;
  }
  return steps;
}

/** Nobody approves their own request, expense or finance entry. */
export function isSelfApproval(approverId: string, ownerId: string): boolean {
  return approverId === ownerId;
}

/** Tasks move DOWN the hierarchy: you can only assign to someone strictly below you. */
export function canAssignTask(assignerId: string, assigneeId: string, assignerDownlineIds: ReadonlySet<string>): boolean {
  return assignerId !== assigneeId && assignerDownlineIds.has(assigneeId);
}
