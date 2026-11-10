import { z } from 'zod';

/**
 * Environment variables the API needs. Checked once at start-up: if something is
 * missing or wrong the app stops immediately with a clear message, instead of failing
 * later in the middle of a request.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must start with postgresql://'),
  FILE_STORAGE_ROOT: z.string().min(1).default('./.local-storage'),
  /**
   * DEVELOPMENT ONLY, until M2 (real login) replaces it. When "true", the API trusts an
   * "X-Dev-Emp-Id" request header as the logged-in employee. Never allowed in production.
   */
  DEV_IDENTITY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.DEV_IDENTITY_ENABLED) {
    ctx.addIssue({
      code: 'custom',
      path: ['DEV_IDENTITY_ENABLED'],
      message: 'The development identity header must never be enabled in production',
    });
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
