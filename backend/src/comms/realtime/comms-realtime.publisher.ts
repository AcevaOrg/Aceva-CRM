import { Injectable } from '@nestjs/common';
import { RealtimeBus } from '../../redis/realtime-bus.service';
import { RedisService } from '../../redis/redis.service';

/** Relay topic for Module 14 changes. */
export const COMMS_TOPIC = 'comms';

/**
 * What the relay carries: pointers only. Never message text, never a cookie, token or session id. Each server reads the
 * current state from PostgreSQL when the pointer arrives and decides, per recipient, what that person may receive.
 */
export type CommsSignal =
  | { kind: 'message'; conversationId: string; messageId: string; created: boolean }
  | { kind: 'receipt'; conversationId: string; employeeId: string }
  | { kind: 'conversation'; conversationId: string };

/** How long "this change was relayed" is remembered, so the outbox safety net only re-sends the ones that were not. */
const RELAYED_MARK_MS = 10 * 60_000;

/**
 * Sends Module 14 change signals to every server. Called only AFTER the change is committed (a screen that hears about
 * a message can always load it). Never throws: if Redis is down the change is still saved, the screens catch up from the
 * database, and the message changes that have an outbox event (new messages, edits, deletions, removals, reactions,
 * pins) are re-sent by the outbox safety net (decision D5). Each successful send is marked by its outbox event id, so
 * the safety net skips it.
 */
@Injectable()
export class CommsRealtimePublisher {
  constructor(
    private readonly bus: RealtimeBus,
    private readonly redis: RedisService,
  ) {}

  /** A new message; `eventId` is its `comms.message.created` outbox event. */
  async messageCreated(conversationId: string, messageId: string, eventId: string): Promise<void> {
    await this.send({ kind: 'message', conversationId, messageId, created: true }, eventId);
  }

  /** A message changed; `eventId` is its `comms.message.changed` outbox event (when there is one). */
  async messageUpdated(conversationId: string, messageId: string, eventId?: string): Promise<void> {
    await this.send({ kind: 'message', conversationId, messageId, created: false }, eventId);
  }

  async receipt(conversationId: string, employeeId: string): Promise<void> {
    await this.bus.publish(COMMS_TOPIC, { kind: 'receipt', conversationId, employeeId } satisfies CommsSignal);
  }

  async conversationChanged(conversationId: string): Promise<void> {
    await this.bus.publish(COMMS_TOPIC, { kind: 'conversation', conversationId } satisfies CommsSignal);
  }

  /** The outbox safety net: re-send a change's signal unless it is known to have gone out. */
  async resendIfNotRelayed(eventId: string, signal: CommsSignal): Promise<'skipped' | 'sent' | 'failed'> {
    try {
      if (await this.redis.client.exists(this.relayedKey(eventId))) return 'skipped';
    } catch {
      return 'failed'; // Redis still down: try again later
    }
    return (await this.send(signal, eventId)) ? 'sent' : 'failed';
  }

  private async send(signal: CommsSignal, eventId?: string): Promise<boolean> {
    const sent = await this.bus.publish(COMMS_TOPIC, signal);
    if (sent && eventId) {
      try {
        await this.redis.client.set(this.relayedKey(eventId), '1', 'PX', RELAYED_MARK_MS);
      } catch {
        // without the mark the safety net sends it once more; screens drop a copy (same number, same revision)
      }
    }
    return sent;
  }

  private relayedKey(eventId: string): string {
    return this.redis.key(`rt:relayed:${eventId}`);
  }
}
