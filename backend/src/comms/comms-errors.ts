import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { isUniqueViolation } from '../common/db-rules';

/**
 * Module 14 privacy rule: a message's text must never reach the application log or an API error.
 *
 * Database errors can carry row values: PostgreSQL's "Failing row contains (...)" detail, the values of a unique key, or
 * the query parameters Prisma attaches. Nest's default error handler logs an unknown error's message and stack, which
 * would copy those values into the log. So every Module 14 database call goes through `commsDb`, which replaces any
 * database error with a `CommsDbError` that carries only the error class, the Prisma code and the SQLSTATE; and every
 * Module 14 controller uses `CommsErrorFilter`, which logs only that summary and answers with a generic error.
 */

/** Rule markers raised by the Module 14 triggers (they name the rule, never a value). */
const RULE_MARKERS = ['(message_rule)', '(conversation_rule)', '(announcement_rule)', '(meeting_rule)', '(attachment_rule)'] as const;

export class CommsDbError extends Error {
  constructor(
    readonly summary: string,
    readonly rule: string | null,
    readonly unique: boolean,
  ) {
    super(`Module 14 database error: ${summary}`);
    this.name = 'CommsDbError';
  }
}

function collectText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { message?: unknown; cause?: unknown; meta?: unknown };
    if (typeof e.message === 'string') parts.push(e.message);
    if (e.meta) {
      try {
        parts.push(JSON.stringify(e.meta));
      } catch {
        // ignore
      }
    }
    current = e.cause;
  }
  return parts.join(' | ');
}

/** A short description of a database error made only of codes (no message, no values). */
export function safeErrorSummary(error: unknown): { summary: string; rule: string | null; unique: boolean } {
  const e = error as { name?: unknown; code?: unknown; constructor?: { name?: string } };
  const klass = (typeof e?.constructor?.name === 'string' && e.constructor.name) || (typeof e?.name === 'string' ? e.name : 'Error');
  const prismaCode = typeof e?.code === 'string' && /^P\d{4}$/.test(e.code) ? e.code : null;
  const text = collectText(error);
  const sqlState = /"(?:originalCode|code)"\s*:\s*"([0-9A-Z]{5})"/.exec(text)?.[1] ?? (typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null);
  const rule = RULE_MARKERS.find((m) => text.includes(m))?.slice(1, -1) ?? null;
  const unique = isUniqueViolation(error);
  const summary = [klass.replace(/[^A-Za-z0-9_]/g, ''), prismaCode && `prisma=${prismaCode}`, sqlState && `sqlstate=${sqlState}`, rule && `rule=${rule}`, unique && 'unique_violation']
    .filter(Boolean)
    .join(' ');
  return { summary, rule, unique };
}

/** Turns any database error into a CommsDbError without the original (its message and cause may hold message text). */
export function sanitizeDbError(error: unknown): unknown {
  if (error instanceof HttpException || error instanceof CommsDbError) return error;
  const { summary, rule, unique } = safeErrorSummary(error);
  return new CommsDbError(summary, rule, unique);
}

/** Runs a Module 14 database step; a database error comes out sanitized. */
export async function commsDb<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw sanitizeDbError(error);
  }
}

/**
 * Every error on a Module 14 route ends here. API errors (4xx and the like) are answered as Nest would answer them.
 * Anything else is logged as a code-only summary and answered with a generic 500 (or 409 when a database rule refused
 * the change), so neither the log nor the response can contain message text.
 */
@Catch()
export class CommsErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Comms');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      res.status(exception.getStatus()).json(typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body);
      return;
    }
    const safe = exception instanceof CommsDbError ? { summary: exception.summary, rule: exception.rule, unique: exception.unique } : safeErrorSummary(exception);
    if (safe.rule || safe.unique) {
      this.logger.warn(`Request refused by a database rule: ${safe.summary}`);
      const conflict = new ConflictException({ statusCode: 409, code: 'conflict', message: 'This change is not allowed or was already made' });
      res.status(409).json(conflict.getResponse());
      return;
    }
    this.logger.error(`Request failed: ${safe.summary}`);
    res.status(500).json({ statusCode: 500, code: 'internal_error', message: 'Something went wrong. Please try again.' });
  }
}
