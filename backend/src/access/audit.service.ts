import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  /** Employee UUID of the person who did it (null = system or not logged in). */
  actorId: string | null;
  /** For example "org.level.changed", "access.denied". */
  action: string;
  targetType: string;
  targetId?: string | null;
  outcome?: 'success' | 'denied';
  /** WHY it was done (required for every change to levels, roles, duties and reporting lines). */
  reason?: string | null;
  /** Before and after values, or the denial details. Never put secrets in here. */
  details?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

type Db = PrismaService | Prisma.TransactionClient;

/** Writes to the insert-only audit_log table. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass `tx` to write in the same transaction as the change being recorded. */
  async record(entry: AuditEntry, tx?: Db): Promise<void> {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        outcome: entry.outcome ?? 'success',
        reason: entry.reason ?? null,
        details: entry.details,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent?.slice(0, 300) ?? null,
        requestId: entry.requestId ?? null,
      },
    });
  }
}
