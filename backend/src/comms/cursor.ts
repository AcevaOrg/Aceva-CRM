import { BadRequestException } from '@nestjs/common';

/** An opaque "continue after this item" marker for lists ordered by a time and an id (newest first). */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: at.toISOString(), id }), 'utf8').toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
    const at = typeof value.t === 'string' ? new Date(value.t) : null;
    if (at && !Number.isNaN(at.getTime()) && typeof value.id === 'string' && UUID.test(value.id)) return { at, id: value.id };
  } catch {
    // fall through
  }
  throw new BadRequestException({ statusCode: 400, code: 'invalid_cursor', message: 'This list position is not valid; start again from the top' });
}
