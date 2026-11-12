import type { ProfileAccessView } from '@aceva/contracts';

/**
 * Who can see and change which part of a profile (plan section 7).
 *
 *   Basic      everyone (the staff directory)
 *   Job        the employee, the levels above them (their reporting line), and Director/HR who manage people
 *   Personal   the employee, HR, Director and above        (permission people.view_personal)
 *   Pay        the employee (own only), Director, CEO, Owner and the finance duty person   (people.view_pay)
 *   Documents  the employee, HR, Director and above        (people.view_personal)
 *
 * Changes:
 *   - the employee changes only their own phone, address and emergency contact
 *   - Director or HR (people.manage) change job-related fields, for people of lower rank or below them
 *   - only the Director (people.manage_pay) changes pay, never their own
 *   - levels and reporting lines change only through the Owner/CEO rules of Module 1; so the Owner and CEO (org.manage)
 *     also get the Job form for people below them (they are the only ones who can reassign a manager)
 *
 * Pure function: the server calls it for every request, and the screens receive the result.
 */
export interface AccessInputs {
  isSelf: boolean;
  /** The caller is above the person in the reporting line. */
  isAbove: boolean;
  /** The person's level is strictly lower in rank than the caller's (a larger level number). */
  lowerRank: boolean;
  can: (permission: string) => boolean;
}

export function computeProfileAccess({ isSelf, isAbove, lowerRank, can }: AccessInputs): ProfileAccessView {
  const manages = can('people.manage');
  // Director or HR may act on people of lower rank or below them in the line, never on themselves.
  const administers = manages && !isSelf && (lowerRank || isAbove);
  const structural = can('org.manage') && !isSelf && (lowerRank || isAbove);
  const personalRole = can('people.view_personal');
  const payRole = can('people.view_pay');
  const job = isSelf || isAbove || manages;

  return {
    isSelf,
    see: {
      basic: true,
      job,
      personal: isSelf || personalRole,
      pay: isSelf || payRole,
      documents: isSelf || personalRole,
      history: job,
    },
    edit: {
      basic: administers,
      job: administers || structural,
      personal: administers ? 'all' : isSelf ? 'contact' : 'none',
      pay: can('people.manage_pay') && !isSelf && (lowerRank || isAbove),
      documents: isSelf || administers,
    },
    revealCnic: isSelf || personalRole,
    revealPay: isSelf || payRole,
  };
}
