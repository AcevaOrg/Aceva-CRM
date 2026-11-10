import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { outboxEventSchema, type OutboxEvent } from '@aceva/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Clock } from '../common/clock';

type Db = PrismaService | Prisma.TransactionClient;

type EventInput = {
  [T in OutboxEvent['type']]: { type: T; actor: OutboxEvent['actor']; payload: Extract<OutboxEvent, { type: T }>['payload'] };
}[OutboxEvent['type']];

/**
 * Writes events for other modules into the outbox table (see packages/contracts/src/events.ts and docs/EVENTS.md).
 * Every event is checked against its contract BEFORE it is saved, so a malformed event can never be stored.
 * Pass `tx` to save the event in the same transaction as the change it describes.
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async emit(event: EventInput, tx?: Db): Promise<void> {
    const occurredAt = this.clock.now();
    const full = outboxEventSchema.parse({
      id: randomUUID(),
      type: event.type,
      version: 1,
      occurredAt: occurredAt.toISOString(),
      actor: event.actor,
      payload: event.payload,
    });
    const db = tx ?? this.prisma;
    await db.outboxEvent.create({
      data: {
        id: full.id,
        type: full.type,
        version: full.version,
        actor: full.actor,
        payload: full.payload as Prisma.InputJsonValue,
        occurredAt,
      },
    });
  }
}
