import { INestApplication, Type } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { generateSync } from 'otplib';
import request from 'supertest';
import { DEMO_EMPLOYEES } from '../../prisma/seed-data';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { Clock } from '../../src/common/clock';
import { Mailer } from '../../src/mail/mailer';
import { RedisService } from '../../src/redis/redis.service';
import { testDatabaseUrl } from './env';
import { FakeClock, MemoryMailer } from './fakes';

export { TEST_PASSWORD } from './reset-db';
import { TEST_PASSWORD } from './reset-db';

export interface Client {
  get: (url: string) => request.Test;
  post: (url: string) => request.Test;
  patch: (url: string) => request.Test;
  delete: (url: string) => request.Test;
}

export interface TestApp {
  app: INestApplication;
  clock: FakeClock;
  mailer: MemoryMailer;
  /** The private folder where this test run keeps uploaded files. */
  storageRoot: string;
  /** A request made "as" a demo person with a real session. Call signInAll() first. */
  as: (empId: string | null) => Client;
  /** Logs every demo person in for real (password, and the authenticator code where 2FA is required). */
  signInAll: () => Promise<void>;
  /** A client with a real session: logs in with Emp-ID and password (and the authenticator code when needed). */
  signIn: (empId: string, options?: { password?: string; rememberMe?: boolean; ip?: string; userAgent?: string }) => Promise<SignedIn>;
  /** A raw login request from a chosen client address. */
  rawLogin: (body: Record<string, unknown>, options?: { ip?: string; userAgent?: string }) => request.Test;
  /** A fresh client address nobody has used yet. */
  freshIp: () => string;
  /** The current 6-digit code for a person whose authenticator was set up through signIn. */
  codeFor: (empId: string) => string;
  /** A raw request to the server, no identity at all. */
  anonymous: () => Client;
  close: () => Promise<void>;
}

export interface SignedIn extends Client {
  empId: string;
  cookie: string;
  csrfToken: string;
  /** The cookie header value only, for building custom requests. */
  headers: () => Record<string, string>;
}

function clientWith(app: INestApplication, apply: (r: request.Test, method: string) => request.Test): Client {
  const server = app.getHttpServer();
  return {
    get: (url) => apply(request(server).get(url), 'GET'),
    post: (url) => apply(request(server).post(url), 'POST'),
    patch: (url) => apply(request(server).patch(url), 'PATCH'),
    delete: (url) => apply(request(server).delete(url), 'DELETE'),
  };
}

/** Starts the real application (all modules) against the aceva_test database and Redis. */
export async function createTestApp(options: { extraControllers?: Type[] } = {}): Promise<TestApp> {
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.NODE_ENV = 'test';
  process.env.REDIS_KEY_PREFIX = 'aceva:test:'; // tests never touch real session data
  process.env.FILE_STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'aceva-private-'));
  process.env.TRUST_PROXY = '1'; // tests choose the client address with X-Forwarded-For

  const clock = new FakeClock();
  const mailer = new MemoryMailer();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers: options.extraControllers ?? [] })
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(Mailer)
    .useValue(mailer)
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  const secrets = new Map<string, string>(); // authenticator secrets created by signIn
  const lastStep = new Map<string, number>(); // a code may be used once per 30-second step
  const codeFor = (empId: string): string => {
    const secret = secrets.get(empId);
    if (!secret) throw new Error(`No authenticator secret known for ${empId}`);
    return generateSync({ secret, epoch: clock.now().getTime() / 1000 });
  };

  // Clean out any session data left in Redis by an earlier run.
  const redis = app.get(RedisService);
  if (redis.isReady) {
    const keys = await redis.client.keys(`${redis.prefix}*`);
    if (keys.length) await redis.client.del(...keys);
  }

  let ipCounter = 0;
  const freshIp = () => {
    ipCounter++;
    return `10.${(Date.now() >> 4) % 250}.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
  };
  const rawLogin: TestApp['rawLogin'] = (body, opts = {}) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', opts.ip ?? freshIp())
      .set('User-Agent', opts.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36')
      .send(body);

  const signIn: TestApp['signIn'] = async (empId, opts = {}) => {
    const password = opts.password ?? TEST_PASSWORD;
    const login = await rawLogin({ empId, password, rememberMe: opts.rememberMe }, { ip: opts.ip, userAgent: opts.userAgent });
    if (login.status !== 200) throw new Error(`Login for ${empId} failed: ${login.status} ${JSON.stringify(login.body)}`);
    const cookieHeader = (login.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('aceva_session='));
    if (!cookieHeader) throw new Error(`Login for ${empId} gave no session cookie (status ${login.body.status})`);
    const cookie = cookieHeader.split(';')[0];
    const csrfToken: string = login.body.csrfToken;
    let status: string = login.body.status;

    const headers = () => ({ Cookie: cookie, 'X-CSRF-Token': csrfToken });
    const apply = (r: request.Test) => r.set(headers());
    const client = clientWith(app, apply);

    if (status === '2fa_setup_required') {
      const setup = await client.post('/api/v1/auth/2fa/setup').expect(200);
      secrets.set(empId, setup.body.secret);
      status = '2fa_required';
    }
    if (status === '2fa_required') {
      // The server refuses a second use of the same code, so move to the next 30-second step when needed.
      const step = () => Math.floor(clock.now().getTime() / 30_000);
      if (lastStep.get(empId) === step()) clock.advance(30_000);
      lastStep.set(empId, step());
      await client.post('/api/v1/auth/2fa/verify').send({ code: codeFor(empId) }).expect(200);
      status = 'ok';
    }
    if (status !== 'ok') throw new Error(`Login for ${empId} ended in "${status}"`);
    return { ...client, empId, cookie, csrfToken, headers };
  };

  const personas = new Map<string, SignedIn>();
  const signInAll = async () => {
    for (const person of DEMO_EMPLOYEES) personas.set(person.empId, await signIn(person.empId));
  };

  return {
    app,
    clock,
    mailer,
    storageRoot: process.env.FILE_STORAGE_ROOT!,
    signIn,
    rawLogin,
    freshIp,
    codeFor,
    signInAll,
    as: (empId) => {
      if (!empId) return clientWith(app, (r) => r);
      const person = personas.get(empId);
      if (!person) throw new Error(`${empId} is not logged in: call signInAll() in beforeAll`);
      return person;
    },
    anonymous: () => clientWith(app, (r) => r),
    close: () => app.close(),
  };
}
