import { Injectable } from '@nestjs/common';
import { MAX_SOCKETS_PER_PERSON } from '@aceva/contracts';
import { RedisService } from '../../redis/redis.service';

/** A live entry lasts this long unless its server refreshes it (every 30 seconds). A crashed server's entries expire. */
export const CONNECTION_TTL_MS = 90_000;

// KEYS[1] = the person's connection set, KEYS[2] = the index of people with connections.
// ARGV: now, expiry, member, max, employeeId. Returns -1 when the person already has `max` live sockets, otherwise how
// many they had before (0 means they just came online).
const CLAIM = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local n = redis.call('ZCARD', KEYS[1])
if n >= tonumber(ARGV[4]) then return -1 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) - tonumber(ARGV[1]) + 60000)
redis.call('ZADD', KEYS[2], 'GT', ARGV[2], ARGV[5])
return n`;

// ARGV: now, member, employeeId. Returns how many live sockets are left (0 means they went offline).
const RELEASE = `
redis.call('ZREM', KEYS[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local n = redis.call('ZCARD', KEYS[1])
if n == 0 then redis.call('ZREM', KEYS[2], ARGV[3]) end
return n`;

// ARGV: now, employeeId. Cleans one person's expired entries; returns 1 when they have none left (offline).
const SWEEP_ONE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local n = redis.call('ZCARD', KEYS[1])
if n == 0 then redis.call('ZREM', KEYS[2], ARGV[2]) return 1 end
return 0`;

export class RegistryUnavailableError extends Error {
  constructor() {
    super('Realtime registry unavailable');
    this.name = 'RegistryUnavailableError';
  }
}

/**
 * Who has live sockets, across every server, in Redis only (never in the database, never kept: there is no presence
 * history). One sorted set per person (`server:socket` entries scored by when they expire) gives both the limit of five
 * sockets per person and "online / offline". Redis being down means new sockets are refused (decision D6).
 */
@Injectable()
export class ConnectionRegistry {
  constructor(private readonly redis: RedisService) {}

  private connKey(employeeId: string): string {
    return this.redis.key(`rt:conn:${employeeId}`);
  }

  private get indexKey(): string {
    return this.redis.key('rt:online');
  }

  /** Takes one of the person's five places. Returns null when all five are in use, else whether they just came online. */
  async claim(employeeId: string, member: string, nowMs: number): Promise<{ cameOnline: boolean } | null> {
    if (!this.redis.isReady) throw new RegistryUnavailableError();
    try {
      const before = (await this.redis.client.eval(CLAIM, 2, this.connKey(employeeId), this.indexKey, nowMs, nowMs + CONNECTION_TTL_MS, member, MAX_SOCKETS_PER_PERSON, employeeId)) as number;
      return before < 0 ? null : { cameOnline: before === 0 };
    } catch {
      throw new RegistryUnavailableError();
    }
  }

  /** Gives the place back. Returns true when that was the person's last live socket (they went offline). */
  async release(employeeId: string, member: string, nowMs: number): Promise<boolean> {
    try {
      const left = (await this.redis.client.eval(RELEASE, 2, this.connKey(employeeId), this.indexKey, nowMs, member, employeeId)) as number;
      return left === 0;
    } catch {
      return false; // the entry expires by itself
    }
  }

  /** Keeps this server's entries alive (and puts them back after a Redis restart). */
  async refresh(entries: Array<{ employeeId: string; member: string }>, nowMs: number): Promise<void> {
    if (!entries.length) return;
    const expiry = nowMs + CONNECTION_TTL_MS;
    const pipeline = this.redis.client.pipeline();
    for (const e of entries) {
      pipeline.zadd(this.connKey(e.employeeId), expiry, e.member);
      pipeline.pexpire(this.connKey(e.employeeId), CONNECTION_TTL_MS + 60_000);
      pipeline.zadd(this.indexKey, 'GT', expiry, e.employeeId);
    }
    try {
      await pipeline.exec();
    } catch {
      // Redis down: the entries come back with the next refresh.
    }
  }

  /** People whose every entry has expired (a server stopped without saying goodbye). Each is reported once. */
  async sweepExpired(nowMs: number): Promise<string[]> {
    try {
      const due = await this.redis.client.zrangebyscore(this.indexKey, '-inf', nowMs, 'LIMIT', 0, 200);
      const gone: string[] = [];
      for (const employeeId of due) {
        const offline = (await this.redis.client.eval(SWEEP_ONE, 2, this.connKey(employeeId), this.indexKey, nowMs, employeeId)) as number;
        if (offline === 1) gone.push(employeeId);
      }
      return gone;
    } catch {
      return [];
    }
  }

  /** Which of these people have a live socket now. Unknown (Redis down) counts as offline. */
  async onlineAmong(employeeIds: string[], nowMs: number): Promise<Set<string>> {
    const online = new Set<string>();
    if (!employeeIds.length) return online;
    try {
      const pipeline = this.redis.client.pipeline();
      for (const id of employeeIds) pipeline.zcount(this.connKey(id), `(${nowMs}`, '+inf');
      const results = (await pipeline.exec()) ?? [];
      results.forEach(([error, count], i) => {
        if (!error && Number(count) > 0) online.add(employeeIds[i]);
      });
    } catch {
      // offline
    }
    return online;
  }

  /** How many live sockets a person has (tests and diagnostics). */
  async count(employeeId: string, nowMs: number): Promise<number> {
    return this.redis.client.zcount(this.connKey(employeeId), `(${nowMs}`, '+inf');
  }

  /** A fixed-window counter for connection attempts. Throws when Redis is down (the attempt is then refused). */
  async attempt(name: string, limit: number, windowMs: number): Promise<boolean> {
    if (!this.redis.isReady) throw new RegistryUnavailableError();
    try {
      const key = this.redis.key(`rt:attempts:${name}`);
      const n = await this.redis.client.incr(key);
      if (n === 1) await this.redis.client.pexpire(key, windowMs);
      return n <= limit;
    } catch {
      throw new RegistryUnavailableError();
    }
  }
}
