import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

describe('environment validation', () => {
  it('accepts a minimal valid configuration and applies defaults', () => {
    const env = loadEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });
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

  it('never allows the development identity header in production', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
    expect(loadEnv({ ...base, DEV_IDENTITY_ENABLED: 'true' }).DEV_IDENTITY_ENABLED).toBe(true);
    expect(loadEnv({ ...base }).DEV_IDENTITY_ENABLED).toBe(false); // off by default
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', DEV_IDENTITY_ENABLED: 'true' })).toThrow(/production/);
  });

  it('rejects an invalid port and an unknown NODE_ENV', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
    expect(() => loadEnv({ ...base, PORT: '99999' })).toThrow(/PORT/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
