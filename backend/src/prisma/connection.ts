import type { PoolConfig } from 'pg';

/**
 * Every PostgreSQL session the app opens runs in UTC. The code stores and compares instants in UTC, and database-side
 * defaults (CURRENT_TIMESTAMP, now()) are written in the session time zone, so a server set to another zone
 * (for example Asia/Karachi on a developer computer) would disagree with the values Prisma writes. Asking for UTC when
 * the connection starts makes that setting of the server irrelevant.
 */
export const UTC_SESSION_OPTIONS = '-c TimeZone=UTC';

/**
 * The pg pool settings for a database URL: the URL itself plus a UTC session time zone. Use it for every connection
 * (the API, the seed scripts, the test helpers). Pass the result to `new PrismaPg(...)` or `new Pool(...)` / `new Client(...)`.
 *
 * pg lets the URL override the settings next to it, so when the URL already carries its own `options` parameter ours is
 * added after it (the last time zone given wins) instead of being ignored.
 */
export function utcPoolConfig(connectionString: string): PoolConfig {
  const plain: PoolConfig = { connectionString, options: UTC_SESSION_OPTIONS };
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return plain;
  }
  const own = url.searchParams.get('options');
  if (!own) return plain;
  url.searchParams.set('options', `${own} ${UTC_SESSION_OPTIONS}`);
  return { connectionString: url.toString() };
}
