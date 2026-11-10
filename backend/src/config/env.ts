import { z } from 'zod';

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

  /** Argon2id cost. The defaults follow OWASP guidance; tests use a cheaper setting. */
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).default(65536),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),

}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.COOKIE_SECURE === false) {
    ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'The session cookie must be Secure in production' });
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
