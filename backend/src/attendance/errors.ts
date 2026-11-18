import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

/** API errors in the shared shape { statusCode, code, message } (docs/API.md). */
export const badRequest = (code: string, message: string) => new BadRequestException({ statusCode: 400, code, message });
export const conflict = (code: string, message: string) => new ConflictException({ statusCode: 409, code, message });
export const forbidden = (code: string, message: string) => new ForbiddenException({ statusCode: 403, code, message });
export const notFound = (message = 'Not found') => new NotFoundException({ statusCode: 404, code: 'not_found', message });

export const periodLocked = (month: string) => conflict('period_locked', `Attendance and leave for ${month} are locked for payroll`);
