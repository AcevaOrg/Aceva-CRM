import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { RedisService } from './redis.service';

export type BusHandler = (payload: unknown) => void | Promise<void>;

/**
 * Module 14, part 2: the signal relay between server copies, over the existing Redis (plain Pub/Sub).
 *
 * Pub/Sub is NOT durable: a message published while a server is disconnected is lost. So nothing depends on it alone:
 * messages are always saved in PostgreSQL first, the relay carries only pointers (ids and sequence numbers, never
 * message text, cookies or tokens), screens catch up from the database by sequence number, and every server tells its
 * sockets to catch up when its subscription comes back after a break (`onResume`).
 *
 * Publishing uses the shared connection (fails fast when Redis is down: the caller carries on, the change is saved).
 * Subscribing needs a connection of its own (a subscribed Redis connection cannot run other commands).
 */
@Injectable()
export class RealtimeBus implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RealtimeBus');
  /** This server copy (for presence entries and for ignoring nothing: every copy handles every signal, its own too). */
  readonly instanceId = randomUUID();
  private subscriber: Redis | null = null;
  private readonly handlers = new Map<string, BusHandler[]>();
  private readonly resumeHandlers: Array<() => void> = [];
  private wasReady = false;
  private interrupted = false;
  /** Tests: pretend publishing fails (a broadcast lost between saving and publishing). */
  dropPublishes = false;

  constructor(private readonly redis: RedisService) {}

  async onModuleInit(): Promise<void> {
    const sub = this.redis.client.duplicate({ lazyConnect: true, autoResubscribe: false, enableOfflineQueue: false });
    this.subscriber = sub;
    sub.on('error', (error) => this.logger.warn(`Relay connection error: ${error.message}`));
    sub.on('close', () => {
      if (this.wasReady) this.interrupted = true;
    });
    sub.on('ready', () => void this.onReady());
    sub.on('message', (channel: string, raw: string) => void this.dispatch(channel, raw));
    try {
      await sub.connect();
    } catch (error) {
      this.logger.warn(`Relay not connected at start-up (it keeps retrying): ${(error as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.subscriber?.disconnect();
    this.subscriber = null;
  }

  /** The Redis channel name for a relay topic (prefixed like every key, so test runs never hear each other). */
  channel(topic: string): string {
    return this.redis.key(`rt:${topic}`);
  }

  get ready(): boolean {
    return this.subscriber?.status === 'ready';
  }

  /** Every server hears this, including the one that sent it. Returns false when it could not be sent (Redis down). */
  async publish(topic: string, payload: Record<string, unknown>): Promise<boolean> {
    if (this.dropPublishes) return false;
    try {
      await this.redis.client.publish(this.channel(topic), JSON.stringify(payload));
      return true;
    } catch (error) {
      // Never log the payload. The change itself is saved; screens catch up by sequence number.
      this.logger.warn(`Relay publish failed on ${topic}: ${(error as Error).message}`);
      return false;
    }
  }

  on(topic: string, handler: BusHandler): void {
    const channel = this.channel(topic);
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
    if (this.ready) void this.subscribe([channel]);
  }

  /** Called when the subscription comes back after a break: anything published meanwhile was lost. */
  onResume(handler: () => void): void {
    this.resumeHandlers.push(handler);
  }

  /** Tests: drop the relay connection (like a network break) and bring it back. */
  async interruptForTest(): Promise<void> {
    if (!this.subscriber) return;
    this.subscriber.disconnect(false);
    this.interrupted = true;
  }

  async resumeForTest(): Promise<void> {
    if (!this.subscriber) return;
    const ready = new Promise<void>((resolve) => this.subscriber!.once('ready', () => resolve()));
    await this.subscriber.connect();
    await ready;
    await new Promise((r) => setImmediate(r));
  }

  private async onReady(): Promise<void> {
    await this.subscribe([...this.handlers.keys()]);
    const resumed = this.wasReady && this.interrupted;
    this.wasReady = true;
    this.interrupted = false;
    if (resumed) {
      this.logger.warn('Relay reconnected: telling local sockets to catch up');
      for (const h of this.resumeHandlers) {
        try {
          h();
        } catch (error) {
          this.logger.error(`Resume handler failed: ${(error as Error).message}`);
        }
      }
    }
  }

  private async subscribe(channels: string[]): Promise<void> {
    if (!channels.length || !this.subscriber) return;
    try {
      await this.subscriber.subscribe(...channels);
    } catch (error) {
      this.logger.warn(`Relay subscribe failed: ${(error as Error).message}`);
    }
  }

  private async dispatch(channel: string, raw: string): Promise<void> {
    const list = this.handlers.get(channel);
    if (!list) return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    for (const h of list) {
      try {
        await h(payload);
      } catch (error) {
        this.logger.error(`Relay handler failed on ${channel}: ${(error as Error).message}`);
      }
    }
  }
}
