import { randomBytes } from 'node:crypto';
import { loadEnv, type Env } from '../../src/config/env';

/** A valid configuration for unit tests (cheap Argon2, throw-away encryption key). */
export function baseEnv(overrides: Record<string, string | undefined> = {}): Env {
  return loadEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/aceva_unit',
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ARGON2_MEMORY_KIB: '1024',
    ARGON2_TIME_COST: '1',
    ...overrides,
  });
}
