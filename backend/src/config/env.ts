import { z } from 'zod';
import { parseIpRanges } from '../activity/rules/ip-ranges';

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

/**
 * Environment variables the API needs. Checked once at start-up: if something is
 * missing or wrong the app stops immediately with a clear message, instead of failing
 * later in the middle of a request.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  /** The public address of the website, used in links inside emails (password reset). */
  APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must start with postgresql://'),
  FILE_STORAGE_ROOT: z.string().min(1).default('./.local-storage'),
  /**
   * The ClamAV daemon (clamd) that checks every file shared in Module 14 before anyone can open it (plan section 19:
   * "malware scanning"). Local only by default. When it cannot be reached, files stay "scanning" and cannot be
   * downloaded until a later check passes (fail closed).
   */
  CLAMD_HOST: z.string().min(1).default('127.0.0.1'),
  CLAMD_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),

  /** Redis holds the fast copy of every session (PostgreSQL keeps the permanent record). */
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required')
    .refine((v) => /^rediss?:\/\//.test(v), 'REDIS_URL must start with redis:// or rediss://'),

  /**
   * 32 random bytes, base64 encoded. Encrypts 2FA secrets (and later CNIC and bank numbers) in the database.
   * Create one with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  DATA_ENCRYPTION_KEY: z
    .string()
    .min(1, 'DATA_ENCRYPTION_KEY is required')
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_ENCRYPTION_KEY must be 32 bytes, base64 encoded'),
  /** Prefix for every Redis key (tests use their own, so they never touch real data). */
  REDIS_KEY_PREFIX: z.string().min(1).default('aceva:'),

  /** Names the key above, so it can be rotated later. */
  DATA_ENCRYPTION_KEY_ID: z.string().min(1).default('v1'),

  /**
   * Module 15.4: the key of the do-not-contact list's keyed hash (HMAC-SHA256 of the normalised email). 32 random bytes,
   * base64 encoded, and its OWN secret (never DATA_ENCRYPTION_KEY). The list keeps only this hash, never the email, so a
   * key can never be thrown away while entries made with it exist: to rotate, give the new key a new id and move the old
   * one (with its id) to SALES_DNC_HMAC_PREVIOUS_KEYS. Required in production. Without it, everything that must check the
   * list (adding, importing or changing a lead's email, adding to the list) is refused; it is never silently skipped.
   * Create one with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  SALES_DNC_HMAC_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'SALES_DNC_HMAC_KEY must be 32 bytes, base64 encoded')
    .optional(),
  /** Names the key above (stored with every entry). */
  SALES_DNC_HMAC_KEY_ID: z.string().regex(/^[A-Za-z0-9_.-]{1,20}$/, 'Letters, digits, dot, dash or underscore (at most 20)').default('v1'),
  /** Earlier do-not-contact keys still needed to match older entries: "id:base64key;id:base64key". */
  SALES_DNC_HMAC_PREVIOUS_KEYS: z.string().default(''),

  /** The session cookie is only sent over HTTPS when true. Defaults to true in production. */
  COOKIE_SECURE: bool.optional(),
  /** How many reverse proxies sit in front of the API (so the real client IP is used for rate limiting). */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

  /** Outgoing email. Local development uses Mailpit (localhost:1025). Production uses real SMTP credentials. */
  SMTP_HOST: z.string().min(1).default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().min(3).default('Aceva <no-reply@acevatech.com>'),

  /** Background workers of the Cycle 3 foundation (outbox readers, notification emails): on | off. Defaults to on, and to
   *  off when NODE_ENV is test, where tests run them step by step. */
  BACKGROUND_WORKERS: z.enum(['on', 'off']).optional(),

  /** Argon2id cost. The defaults follow OWASP guidance; tests use a cheaper setting. */
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).default(65536),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),

  /**
   * Module 4: approximate city from the internet address, from a LOCAL list of address ranges (no outside GeoIP service
   * is ever called). Example: "39.45.0.0/16=Karachi; 182.185.0.0/16=Lahore". Empty = every city is "unknown".
   */
  GEOIP_RANGES: z.string().default(''),
  /**
   * How often the outbox dispatcher looks for new events, in milliseconds. 0 switches automatic dispatching off (the
   * automated tests do this and call OutboxDispatcher.tick() themselves).
   */
  OUTBOX_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(0).max(600_000).default(5000),
  /** Module 4: build the nightly activity summaries at 00:15 Pakistan time ("off" in the automated tests). */
  ACTIVITY_SUMMARY_SCHEDULE: z.enum(['on', 'off']).default('on'),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.COOKIE_SECURE === false) {
    ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'The session cookie must be Secure in production' });
  }
  if (env.NODE_ENV === 'production' && !env.SALES_DNC_HMAC_KEY) {
    ctx.addIssue({ code: 'custom', path: ['SALES_DNC_HMAC_KEY'], message: 'The do-not-contact list needs its key in production' });
  }
  try {
    const previous = parseDncPreviousKeys(env.SALES_DNC_HMAC_PREVIOUS_KEYS);
    if (previous.has(env.SALES_DNC_HMAC_KEY_ID)) throw new Error(`The key id ${env.SALES_DNC_HMAC_KEY_ID} is both current and previous`);
  } catch (error) {
    ctx.addIssue({ code: 'custom', path: ['SALES_DNC_HMAC_PREVIOUS_KEYS'], message: (error as Error).message });
  }
  try {
    parseIpRanges(env.GEOIP_RANGES);
  } catch (error) {
    ctx.addIssue({ code: 'custom', path: ['GEOIP_RANGES'], message: (error as Error).message });
  }
});

export type Env = z.infer<typeof envSchema>;

/** Parses the given variables and throws one readable error listing every problem. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

/** Whether the background workers (outbox readers, notification emails) run on their own timer. */
export function backgroundWorkersOn(env: Pick<Env, 'BACKGROUND_WORKERS' | 'NODE_ENV'>): boolean {
  return env.BACKGROUND_WORKERS ? env.BACKGROUND_WORKERS === 'on' : env.NODE_ENV !== 'test';
}

/** SALES_DNC_HMAC_PREVIOUS_KEYS ("id:base64key;id:base64key") as id -> 32-byte key. Throws a readable error. */
export function parseDncPreviousKeys(text: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const part of text.split(';').map((p) => p.trim()).filter(Boolean)) {
    const at = part.indexOf(':');
    const id = at > 0 ? part.slice(0, at).trim() : '';
    const key = Buffer.from(at > 0 ? part.slice(at + 1).trim() : '', 'base64');
    if (!/^[A-Za-z0-9_.-]{1,20}$/.test(id) || key.length !== 32) throw new Error('Each previous key is "id:" and 32 bytes, base64 encoded');
    if (keys.has(id)) throw new Error(`The key id ${id} appears twice`);
    keys.set(id, key);
  }
  return keys;
}
