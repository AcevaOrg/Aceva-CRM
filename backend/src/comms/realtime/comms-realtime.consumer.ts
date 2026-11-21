import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { OutboxConsumerRunner } from '../../events/outbox-consumer-runner.service';
import { CommsRealtimePublisher } from './comms-realtime.publisher';

/** Older than this, a missed live change is left to the screens' own catch-up (they reload what they show on reconnect). */
const RESEND_WITHIN_MS = 5 * 60_000;

/**
 * Decision D5: the outbox as a delayed safety net for live delivery. A message's live signal is sent right after it is
 * saved or changed; if that send was lost (Redis down at that moment, or the server stopped in between), this reader
 * sends it again when it reads the outbox event (within about ten seconds): new messages (`comms.message.created`) and
 * edits, deletions, removals, reactions and pins (`comms.message.changed`). Signals that did go out are recognised by
 * their event id and skipped. Each server renders the CURRENT state from the database, so a late signal never shows
 * anything stale. Redis still down: the event is retried later.
 */
@Injectable()
export class CommsRealtimeOutboxConsumer implements OnModuleInit {
  constructor(
    private readonly runner: OutboxConsumerRunner,
    private readonly publisher: CommsRealtimePublisher,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.runner.register({
      name: 'comms-realtime',
      types: ['comms.message.created', 'comms.message.changed'],
      handle: async (event) => {
        if (event.type !== 'comms.message.created' && event.type !== 'comms.message.changed') return;
        if (this.clock.now().getTime() - new Date(event.occurredAt).getTime() > RESEND_WITHIN_MS) return;
        const { conversationId, messageId } = event.payload;
        const outcome = await this.publisher.resendIfNotRelayed(event.id, { kind: 'message', conversationId, messageId, created: event.type === 'comms.message.created' });
        if (outcome === 'failed') throw new Error('Realtime relay unavailable');
      },
    });
  }
}
