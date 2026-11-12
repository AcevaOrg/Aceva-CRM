import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

describe('environment validation', () => {
  it('accepts a minimal valid configuration and applies defaults', () => {
    const env = loadEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://127.0.0.1:6379', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') });
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CORS_ORIGIN).toBe('http://localhost:3000');
  });

  it('fails clearly when DATABASE_URL is missing', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a DATABASE_URL that is not a PostgreSQL address', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://u:p@localhost/db' })).toThrow(/postgresql/);
  });

  it('requires Redis and an encryption key, and refuses an insecure session cookie in production', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://127.0.0.1:6379', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
    expect(() => loadEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(/REDIS_URL/);
    expect(() => loadEnv({ DATABASE_URL: base.DATABASE_URL, REDIS_URL: base.REDIS_URL })).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...base, DATA_ENCRYPTION_KEY: 'too-short' })).toThrow(/32 bytes/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/Secure/);
    expect(loadEnv({ ...base, NODE_ENV: 'production' }).COOKIE_SECURE).toBeUndefined(); // defaults to Secure in production
  });

  it('rejects an invalid port and an unknown NODE_ENV', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://127.0.0.1:6379', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
    expect(() => loadEnv({ ...base, PORT: '99999' })).toThrow(/PORT/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
