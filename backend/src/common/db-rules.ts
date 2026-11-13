import { BadRequestException, ConflictException, ForbiddenException, HttpException } from '@nestjs/common';

/**
 * The database triggers of the M7-M9 foundation migration refuse forbidden changes even if application code has a bug
 * (a posted entry edited, a closed month written to, an unbalanced entry...). The services check the same rules first and
 * answer with a clear error; this maps a trigger refusal that still reaches them to the same API error, instead of a 500.
 */
const RULES: Array<{ marker: string; code: string; status: 400 | 403 | 409; message: string }> = [
  { marker: '(owner_approval_inherited)', code: 'owner_approval_inherited', status: 409, message: 'This account is under an account that needs Owner approval, so it needs it too' },
  { marker: '(owner_only)', code: 'owner_only', status: 403, message: 'Only the Owner may do this' },
  { marker: '(period_locked)', code: 'period_locked', status: 409, message: 'This month is locked for payroll' },
  { marker: '(period_closed)', code: 'period_closed', status: 409, message: 'This month is closed' },
  { marker: '(unbalanced_entry)', code: 'unbalanced_entry', status: 400, message: 'Total debits must equal total credits' },
  { marker: 'can never be edited', code: 'entry_immutable', status: 409, message: 'A posted entry can never be edited; reverse it instead' },
  { marker: 'waiting for approval cannot be edited', code: 'invalid_transition', status: 409, message: 'An entry waiting for approval cannot be edited' },
  { marker: 'lines of a', code: 'entry_immutable', status: 409, message: 'Only a draft entry can be changed' },
  { marker: 'approved payroll run cannot be changed', code: 'run_locked', status: 409, message: 'An approved payroll run cannot be changed; use an adjustment' },
  { marker: 'payroll lines cannot change', code: 'run_locked', status: 409, message: 'Payroll lines cannot change once the run is prepared' },
  { marker: 'original check-in and check-out', code: 'original_kept', status: 409, message: 'The original check-in and check-out are kept' },
  { marker: 'decided correction request', code: 'invalid_transition', status: 409, message: 'This correction was already decided' },
  { marker: 'decided leave request', code: 'invalid_transition', status: 409, message: 'This leave request was already decided' },
];

function messagesOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { message?: unknown; cause?: unknown; meta?: unknown };
    if (typeof e.message === 'string') parts.push(e.message);
    if (e.meta) parts.push(JSON.stringify(e.meta));
    current = e.cause;
  }
  return parts.join(' | ');
}

/** The API error for a database rule refusal, or null when the error is something else. */
export function dbRuleError(error: unknown): HttpException | null {
  if (error instanceof HttpException) return null;
  const text = messagesOf(error);
  const rule = RULES.find((r) => text.includes(r.marker));
  if (!rule) return null;
  const body = { statusCode: rule.status, code: rule.code, message: rule.message };
  if (rule.status === 403) return new ForbiddenException(body);
  return rule.status === 400 ? new BadRequestException(body) : new ConflictException(body);
}

/** True for a unique-constraint violation (Prisma P2002), e.g. a duplicate check-in or a second posting of the same source. */
export function isUniqueViolation(error: unknown): boolean {
  const text = messagesOf(error);
  return (error as { code?: string })?.code === 'P2002' || text.includes('Unique constraint') || text.includes('duplicate key value');
}

/** Runs `fn`; a database rule refusal becomes the matching API error. */
export async function withDbRules<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw dbRuleError(error) ?? error;
  }
}
