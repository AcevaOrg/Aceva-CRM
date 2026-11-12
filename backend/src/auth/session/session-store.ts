import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/** What is kept in the fast store for each live session. */
export interface CachedSession {
  id: string;
  employeeId: string;
  empId: string;
  /** Milliseconds since 1970 (UTC). */
  createdAt: number;
  lastActiveAt: number;
  absoluteExpiresAt: number;
  rememberMe: boolean;
  twoFactorVerified: boolean;
  csrfHash: string;
  /** When PostgreSQL last received this session's last-active time. */
  pgSyncedAt: number;
}

/**
 * The fast session store. Today: Redis. The permanent record is always the PostgreSQL `sessions` table;
 * this store only makes the per-request check quick. Methods return null/do nothing when the store is
 * unavailable, and the caller falls back to PostgreSQL.
 */
export abstract class SessionStore {
  abstract get(tokenHash: string): Promise<CachedSession | null>;
  abstract set(tokenHash: string, session: CachedSession, ttlSeconds: number): Promise<void>;
  abstract delete(tokenHash: string): Promise<void>;
}

@Injectable()
export class RedisSessionStore extends SessionStore {
  private readonly logger = new Logger('SessionStore');

  constructor(private readonly redis: RedisService) {
    super();
  }

  async get(tokenHash: string): Promise<CachedSession | null> {
    try {
      const raw = await this.redis.client.get(this.redis.key(`sess:${tokenHash}`));
      return raw ? (JSON.parse(raw) as CachedSession) : null;
    } catch (error) {
      this.logger.warn(`Redis read failed, using PostgreSQL: ${(error as Error).message}`);
      return null;
    }
  }

  async set(tokenHash: string, session: CachedSession, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.client.set(this.redis.key(`sess:${tokenHash}`), JSON.stringify(session), 'EX', Math.max(1, Math.ceil(ttlSeconds)));
    } catch (error) {
      this.logger.warn(`Redis write failed: ${(error as Error).message}`);
    }
  }

  async delete(tokenHash: string): Promise<void> {
    try {
      await this.redis.client.del(this.redis.key(`sess:${tokenHash}`));
    } catch (error) {
      this.logger.warn(`Redis delete failed: ${(error as Error).message}`);
    }
  }
}
