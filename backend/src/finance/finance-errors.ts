import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

/** Finance API errors in the shared shape { statusCode, code, message } (docs/API.md). */
export const badRequest = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new BadRequestException({ statusCode: 400, code, message, ...extra });
export const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new ConflictException({ statusCode: 409, code, message, ...extra });
export const forbidden = (code: string, message: string) => new ForbiddenException({ statusCode: 403, code, message });
export const notFound = (what: string) => new NotFoundException({ statusCode: 404, code: 'not_found', message: `${what} not found` });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string | null | undefined): value is string => !!value && UUID.test(value);
