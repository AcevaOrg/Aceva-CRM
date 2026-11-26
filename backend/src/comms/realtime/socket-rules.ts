import type { IncomingMessage } from 'node:http';

/**
 * Small, pure rules for the Module 14 socket (kept apart so they are unit-tested without a server).
 */

/** The value of one cookie from a Cookie header (null when absent). Values set by Express are URL-encoded. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    try {
      return decodeURIComponent(raw) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Socket.IO's CORS setting does not protect a WebSocket (browsers do not apply CORS to it), so the Origin header is
 * checked here for every connection. A browser always sends it; a missing Origin is refused too.
 */
export function originAllowed(origin: string | undefined, allowed: string): boolean {
  return typeof origin === 'string' && origin.length > 0 && origin === allowed;
}

/**
 * The client address, the way Express works it out with `trust proxy` set to a number of proxies: the address that
 * many hops back in X-Forwarded-For (the last proxy's view), otherwise the socket's own address.
 */
export function clientAddress(request: IncomingMessage, trustProxy: number): string {
  const direct = request.socket?.remoteAddress ?? 'unknown';
  if (trustProxy <= 0) return direct;
  const header = request.headers['x-forwarded-for'];
  const list = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  const chain = [...list, direct];
  return chain[Math.max(0, chain.length - 1 - trustProxy)] ?? direct;
}

/**
 * A token bucket: `capacity` packets at once, refilled at `perSecond`. Time is passed in, so it is exact in tests.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    nowMs: number,
  ) {
    this.tokens = capacity;
    this.last = nowMs;
  }

  take(nowMs: number): boolean {
    const elapsed = Math.max(0, nowMs - this.last);
    this.last = nowMs;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.perSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Counts refusals in a sliding one-second window: a socket that keeps pushing past its limit is closed.
 */
export class RefusalCounter {
  private stamps: number[] = [];

  constructor(private readonly max: number) {}

  /** Records one refusal; true when there were more than `max` in the last second. */
  hit(nowMs: number): boolean {
    this.stamps = this.stamps.filter((t) => nowMs - t < 1000);
    this.stamps.push(nowMs);
    return this.stamps.length > this.max;
  }
}
