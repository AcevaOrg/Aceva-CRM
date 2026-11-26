import { BadRequestException, Injectable } from '@nestjs/common';
import type { CommsAuditEventView, CommsAuditQuery, CursorPage } from '@aceva/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { commsDb } from './comms-errors';

/** Action groups for the filter (an exact action name works too). */
const GROUPS: Record<string, Prisma.AuditLogWhereInput> = {
  messages: { action: { startsWith: 'comms.message.' } },
  conversations: { OR: [{ action: { startsWith: 'comms.conversation.' } }, { action: { startsWith: 'comms.member.' } }, { action: { startsWith: 'comms.moderator.' } }] },
  files: { action: { startsWith: 'comms.file.' } },
  announcements: { action: { startsWith: 'comms.announcement.' } },
  meetings: { action: { startsWith: 'comms.meeting.' } },
  settings: { action: 'settings.module.changed', targetId: 'comms' },
  denied: { action: 'access.denied', targetType: 'route', targetId: { contains: '/comms' } },
};

/** Everything Module 14 writes to the shared audit log, and refusals on its routes. */
const ALL_COMMS: Prisma.AuditLogWhereInput = { OR: [{ action: { startsWith: 'comms.' } }, GROUPS.settings, GROUPS.denied] };

/**
 * Plan section 19: "Admins can ... review security/audit events". comms.admin reads Module 14's records in the shared
 * audit log (newest first): who did what to which conversation, message, file, announcement or meeting, refusals and
 * malware findings. Metadata only: the audit log never holds message text, file names, agendas or notes (Module 14 never
 * writes them there), so this view cannot expose a private conversation's content.
 */
@Injectable()
export class CommsAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: CommsAuditQuery): Promise<CursorPage<CommsAuditEventView>> {
    const and: Prisma.AuditLogWhereInput[] = [ALL_COMMS];
    if (q.action) and.push(GROUPS[q.action] ?? { action: q.action });
    if (q.outcome) and.push({ outcome: q.outcome });
    if (q.from) and.push({ occurredAt: { gte: new Date(q.from) } });
    if (q.to) and.push({ occurredAt: { lte: new Date(q.to) } });
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (cursor) and.push({ OR: [{ occurredAt: { lt: cursor.at } }, { occurredAt: cursor.at, id: { lt: cursor.id } }] });
    const rows = await commsDb(() =>
      this.prisma.auditLog.findMany({ where: { AND: and }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: q.limit + 1 }),
    );
    const page = rows.slice(0, q.limit);
    const actors = [...new Set(page.map((r) => r.actorId).filter((x): x is string => !!x))];
    const people = actors.length ? await commsDb(() => this.prisma.employee.findMany({ where: { id: { in: actors } }, select: { id: true, empId: true } })) : [];
    const empIdOf = new Map(people.map((p) => [p.id, p.empId]));
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        at: r.occurredAt.toISOString(),
        actorEmpId: r.actorId ? (empIdOf.get(r.actorId) ?? null) : null,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        outcome: r.outcome === 'denied' ? 'denied' : 'success',
        reason: r.reason,
        details: (r.details as Record<string, unknown> | null) ?? null,
      })),
      nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.occurredAt.toISOString()}|${last.id}`).toString('base64url') : null,
    };
  }
}

function decodeCursor(raw: string): { at: Date; id: string } {
  const [at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const date = new Date(at ?? '');
  if (!id || Number.isNaN(date.getTime())) throw new BadRequestException({ statusCode: 400, code: 'invalid_cursor', message: 'Invalid cursor' });
  return { at: date, id };
}
