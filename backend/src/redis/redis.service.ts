import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

/**
 * The one Redis connection. Redis is the FAST copy of session data; PostgreSQL stays the permanent record.
 * If Redis is down, commands fail fast (no waiting queue) and callers fall back to PostgreSQL.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Redis');
  readonly client: Redis;
  /** Prefix for every key, so tests (and other apps) never touch each other's data. */
  readonly prefix: string;

  constructor(@Inject(ENV) env: Env) {
    this.prefix = env.REDIS_KEY_PREFIX;
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    this.client.on('error', (error) => this.logger.warn(`Redis error: ${error.message}`));
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      this.logger.warn(`Could not connect to Redis at start-up (sessions fall back to PostgreSQL): ${(error as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }

  key(name: string): string {
    return `${this.prefix}${name}`;
  }

  get isReady(): boolean {
    return this.client.status === 'ready';
  }
}
