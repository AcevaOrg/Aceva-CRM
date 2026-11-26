import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
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
export function notFound(what = 'Not found'): never {
  throw new NotFoundException({ statusCode: 404, code: 'not_found', message: what });
}
/** 503: a check the action depends on cannot be made right now, so the action is refused (never done unchecked). */
export function serviceUnavailable(code: string, message: string): never {
  throw new HttpException({ statusCode: 503, code, message }, HttpStatus.SERVICE_UNAVAILABLE);
}
export function tooManyRequests(message: string): never {
  throw new HttpException({ statusCode: 429, code: 'rate_limited', message }, HttpStatus.TOO_MANY_REQUESTS);
}
