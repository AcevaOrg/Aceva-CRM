import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { UTC_SESSION_OPTIONS, utcPoolConfig } from './connection';

/** What pg will send to the server when it connects (no connection is opened here). */
function startupOptions(connectionString: string): string | undefined {
  const client = new Client(utcPoolConfig(connectionString));
  return (client as unknown as { connectionParameters: { options?: string } }).connectionParameters.options;
}

describe('database connection settings', () => {
  const url = 'postgresql://aceva_app:local-only-db-password@127.0.0.1:5432/aceva_dev';

  it('asks for a UTC session time zone and keeps the URL as it is', () => {
    expect(UTC_SESSION_OPTIONS).toBe('-c TimeZone=UTC');
    expect(utcPoolConfig(url)).toEqual({ connectionString: url, options: '-c TimeZone=UTC' });
  });

  it('is what pg sends when it connects', () => {
    expect(startupOptions(url)).toBe('-c TimeZone=UTC');
  });

  it('adds the time zone after options that the URL already carries, so the URL cannot switch it off', () => {
    const own = `${url}?options=${encodeURIComponent('-c search_path=app -c TimeZone=Asia/Karachi')}&application_name=aceva`;
    const config = utcPoolConfig(own);
    expect(config.options).toBeUndefined();
    expect(startupOptions(own)).toBe('-c search_path=app -c TimeZone=Asia/Karachi -c TimeZone=UTC');
    expect(new URL(config.connectionString as string).searchParams.get('application_name')).toBe('aceva');
  });

  it('keeps passwords with special characters intact', () => {
    const tricky = 'postgresql://aceva_app:p%40ss%2Fword@db.internal:5432/aceva_dev?sslmode=disable';
    expect(utcPoolConfig(tricky).connectionString).toBe(tricky);
    const withOptions = `${tricky}&options=${encodeURIComponent('-c statement_timeout=5000')}`;
    const merged = new URL(utcPoolConfig(withOptions).connectionString as string);
    expect(merged.password).toBe('p%40ss%2Fword');
    expect(merged.searchParams.get('sslmode')).toBe('disable');
  });
});
