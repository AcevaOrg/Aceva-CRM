import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PayrollPersonRef } from '@aceva/contracts';
import type { Prisma } from '../generated/prisma/client';
import { dbDate, firstDayOfMonth, lastDayOfMonth } from '../common/pakistan-time';
import type { PrismaService } from '../prisma/prisma.service';

export type Db = PrismaService | Prisma.TransactionClient;

/** Errors in the shape of docs/API.md: { statusCode, code, message }. */
export function conflict(code: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new ConflictException({ statusCode: 409, code, message, ...extra });
}
export function badRequest(code: string, message: string): never {
  throw new BadRequestException({ statusCode: 400, code, message });
}
export function forbidden(code: string, message: string): never {
  throw new ForbiddenException({ statusCode: 403, code, message });
}
/** Payroll is highly confidential (plan section 16): anything a person may not see is simply "not found". */
export function notFound(what = 'Not found'): never {
  throw new NotFoundException({ statusCode: 404, code: 'not_found', message: what });
}

/** Runs are addressed by id (UUID) or by number (PR-2026-11). */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who is in a month's run: employed at some point in the month (joined on or before its last day, and not left before its
 * first day). Whether they have pay on file is checked by the caller.
 */
export function employedInMonthWhere(month: string): Prisma.EmployeeWhereInput {
  return {
    joiningDate: { lte: dbDate(lastDayOfMonth(month)) },
    OR: [{ lastWorkingDay: null }, { lastWorkingDay: { gte: dbDate(firstDayOfMonth(month)) } }],
  };
}

/** Emp-ID and name for employee UUIDs (actor columns hold UUIDs; the API shows Emp-IDs). */
export async function peopleByIds(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, PayrollPersonRef>> {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (!wanted.length) return new Map();
  const rows = await db.employee.findMany({ where: { id: { in: wanted } }, select: { id: true, empId: true, fullName: true } });
  return new Map(rows.map((r) => [r.id, { empId: r.empId, name: r.fullName }]));
}

export function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}
