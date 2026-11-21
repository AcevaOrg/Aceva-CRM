import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { REALTIME_PATH } from '@aceva/contracts';
import { CommsRealtimeDelivery } from '../../src/comms/realtime/comms-realtime.delivery';
import { CommsGateway } from '../../src/comms/realtime/comms.gateway';
import { ENV } from '../../src/config/config.module';
import type { Env } from '../../src/config/env';
import { RealtimeBus } from '../../src/redis/realtime-bus.service';
import { RedisService } from '../../src/redis/redis.service';
import type { TestApp } from './app';

/**
 * Module 14, part 2 test helpers: a real listening server and real Socket.IO clients (WebSocket only), so the handshake,
 * the cookie, the Origin check and the Redis relay are exercised exactly as a browser would.
 */
export interface LiveServer {
  t: TestApp;
  url: string;
  origin: string;
  gateway: CommsGateway;
  delivery: CommsRealtimeDelivery;
  bus: RealtimeBus;
  redis: RedisService;
}

export async function listen(t: TestApp): Promise<LiveServer> {
  await t.app.listen(0, '127.0.0.1');
  const address = t.app.getHttpServer().address() as AddressInfo;
  return {
    t,
    url: `http://127.0.0.1:${address.port}`,
    origin: t.app.get<Env>(ENV).CORS_ORIGIN,
    gateway: t.app.get(CommsGateway),
    delivery: t.app.get(CommsRealtimeDelivery),
    bus: t.app.get(RealtimeBus),
    redis: t.app.get(RedisService),
  };
}

export interface Received {
  event: string;
  data: unknown;
}

export interface LiveClient {
  socket: Socket;
  events: Received[];
  /** The first event of this name (after `since`) matching `match`, waiting for it if needed. */
  waitFor: <T = Record<string, unknown>>(event: string, match?: (data: T) => boolean, options?: { since?: number; timeoutMs?: number }) => Promise<T>;
  /** Everything of this name received so far. */
  all: <T = Record<string, unknown>>(event: string) => T[];
  /** Resolves when the server closes this socket. */
  closed: Promise<string>;
  close: () => void;
}

let ipCounter = 0;
const freshAddress = () => `172.${16 + (ipCounter % 16)}.${Math.floor(++ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;

interface ConnectOptions {
  cookie?: string | null;
  origin?: string | null;
  /** Answer "message.created" acknowledgements (like the real screen does). Default true. */
  ack?: boolean;
  address?: string;
}

function open(server: LiveServer, options: ConnectOptions): Socket {
  const headers: Record<string, string> = { 'X-Forwarded-For': options.address ?? freshAddress() };
  if (options.cookie) headers.Cookie = options.cookie;
  const origin = options.origin === undefined ? server.origin : options.origin;
  if (origin) headers.Origin = origin;
  return io(server.url, { path: REALTIME_PATH, transports: ['websocket'], extraHeaders: headers, reconnection: false, forceNew: true, timeout: 10_000 });
}

/** Connects; rejects with the refusal code when the server refuses. */
export function connect(server: LiveServer, options: ConnectOptions): Promise<LiveClient> {
  const socket = open(server, options);
  const events: Received[] = [];
  const waiters: Array<() => void> = [];
  socket.onAny((event: string, ...args: unknown[]) => {
    events.push({ event, data: args[0] });
    const ack = args[args.length - 1];
    if (event === 'message.created' && typeof ack === 'function' && options.ack !== false) (ack as (r: unknown) => void)({ ok: true });
    for (const w of [...waiters]) w();
  });
  let closedResolve: (reason: string) => void = () => undefined;
  const closed = new Promise<string>((resolve) => (closedResolve = resolve));
  socket.on('disconnect', (reason) => closedResolve(String(reason)));

  const client: LiveClient = {
    socket,
    events,
    all: <T>(event: string) => events.filter((e) => e.event === event).map((e) => e.data as T),
    waitFor: <T>(event: string, match: (data: T) => boolean = () => true, opts: { since?: number; timeoutMs?: number } = {}) =>
      new Promise<T>((resolve, reject) => {
        const since = opts.since ?? 0;
        const find = () => events.slice(since).find((e) => e.event === event && match(e.data as T));
        const hit = find();
        if (hit) return resolve(hit.data as T);
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error(`No "${event}" event arrived (received: ${events.map((e) => e.event).join(', ') || 'nothing'})`));
        }, opts.timeoutMs ?? 8_000);
        const check = () => {
          const found = find();
          if (!found) return;
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(found.data as T);
        };
        waiters.push(check);
      }),
    closed,
    close: () => socket.disconnect(),
  };
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(client));
    socket.once('connect_error', (error: Error & { data?: { code?: string } }) => {
      socket.disconnect();
      reject(Object.assign(new Error(error.data?.code ?? error.message), { code: error.data?.code ?? 'transport_error' }));
    });
  });
}

/** The refusal code of a connection the server must refuse. */
export async function refusalOf(server: LiveServer, options: ConnectOptions): Promise<string> {
  try {
    const c = await connect(server, options);
    c.close();
    return 'connected';
  } catch (error) {
    return (error as { code: string }).code;
  }
}

/** The HTTP status of a raw WebSocket upgrade request (the Origin check answers before any Socket.IO code runs). */
export function upgradeStatus(server: LiveServer, headers: Record<string, string>): Promise<number> {
  const url = new URL(`${server.url}${REALTIME_PATH}/?EIO=4&transport=websocket`);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Lets every server finish what it has queued (after a barrier event proved the relay has passed everything on). */
export async function settle(...servers: LiveServer[]): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all(servers.map((s) => s.delivery.idle()));
  }
}

/** Clears the connection-attempt counters (each test starts with a fresh minute). */
export async function resetAttempts(server: LiveServer): Promise<void> {
  const keys = await server.redis.client.keys(`${server.redis.prefix}rt:attempts:*`);
  if (keys.length) await server.redis.client.del(...keys);
}
