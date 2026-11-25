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
    // Production also needs the do-not-contact key (Module 15.4), so the production checks below include one.
    const prod = { ...base, NODE_ENV: 'production', SALES_DNC_HMAC_KEY: Buffer.alloc(32, 2).toString('base64') };
    expect(() => loadEnv({ ...prod, COOKIE_SECURE: 'false' })).toThrow(/Secure/);
    expect(loadEnv(prod).COOKIE_SECURE).toBeUndefined(); // defaults to Secure in production
  });

  it('Module 15.4: the do-not-contact key is its own 32-byte key, required in production, with checked previous keys', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://127.0.0.1:6379', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
    const key = Buffer.alloc(32, 2).toString('base64');
    const dev = loadEnv(base); // optional outside production (the list then refuses to work, 503)
    expect(dev.SALES_DNC_HMAC_KEY).toBeUndefined();
    expect(dev).toMatchObject({ SALES_DNC_HMAC_KEY_ID: 'v1', SALES_DNC_HMAC_PREVIOUS_KEYS: '' });
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/SALES_DNC_HMAC_KEY/);
    expect(() => loadEnv({ ...base, SALES_DNC_HMAC_KEY: 'too-short' })).toThrow(/32 bytes/);
    expect(loadEnv({ ...base, SALES_DNC_HMAC_KEY: key, SALES_DNC_HMAC_KEY_ID: 'v2', SALES_DNC_HMAC_PREVIOUS_KEYS: `v1:${Buffer.alloc(32, 3).toString('base64')}` }).SALES_DNC_HMAC_KEY_ID).toBe('v2');
    expect(() => loadEnv({ ...base, SALES_DNC_HMAC_KEY: key, SALES_DNC_HMAC_PREVIOUS_KEYS: 'v1:short' })).toThrow(/SALES_DNC_HMAC_PREVIOUS_KEYS/);
    expect(() => loadEnv({ ...base, SALES_DNC_HMAC_KEY: key, SALES_DNC_HMAC_PREVIOUS_KEYS: `v1:${key}` })).toThrow(/both current and previous/);
  });

  it('Module 4 settings: safe defaults, a checked local city list, the dispatcher interval and the nightly schedule', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://127.0.0.1:6379', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
    const env = loadEnv(base);
    expect(env).toMatchObject({ GEOIP_RANGES: '', OUTBOX_DISPATCH_INTERVAL_MS: 5000, ACTIVITY_SUMMARY_SCHEDULE: 'on' });
    expect(loadEnv({ ...base, GEOIP_RANGES: '39.45.0.0/16=Karachi; 182.185.0.0/16=Lahore' }).GEOIP_RANGES).toContain('Karachi');
    expect(() => loadEnv({ ...base, GEOIP_RANGES: 'Karachi' })).toThrow(/GEOIP_RANGES/);
    expect(loadEnv({ ...base, OUTBOX_DISPATCH_INTERVAL_MS: '0', ACTIVITY_SUMMARY_SCHEDULE: 'off' })).toMatchObject({ OUTBOX_DISPATCH_INTERVAL_MS: 0, ACTIVITY_SUMMARY_SCHEDULE: 'off' });
    expect(() => loadEnv({ ...base, OUTBOX_DISPATCH_INTERVAL_MS: '-1' })).toThrow(/OUTBOX_DISPATCH_INTERVAL_MS/);
    expect(() => loadEnv({ ...base, ACTIVITY_SUMMARY_SCHEDULE: 'sometimes' })).toThrow(/ACTIVITY_SUMMARY_SCHEDULE/);
  });

  it('rejects an invalid port and an unknown NODE_ENV', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://127.0.0.1:6379', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
    expect(() => loadEnv({ ...base, PORT: '99999' })).toThrow(/PORT/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
