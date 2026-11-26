/**
 * The safety check in front of every destructive test step (the reset drops the whole public schema).
 *
 * A test run may empty and rebuild a database ONLY when its name is EXACTLY one of the approved disposable test
 * databases:
 *   - the ones listed in DISPOSABLE_TEST_DATABASES below (approved for local development), and
 *   - the ones named in ACEVA_APPROVED_TEST_DATABASES (comma-separated), set explicitly where a run needs another one,
 *     for example CI's throw-away aceva_test container (.github/workflows/ci.yml).
 * There is no fallback: a name that is not approved stops the run before anything is touched, and a "test" somewhere in
 * the name is not enough. The databases in PROTECTED_DATABASES are refused even if someone lists them as approved.
 *
 * The host must be this computer (localhost, 127.0.0.1 or ::1): a test run never resets a database on another server.
 *
 * This file has no dependencies, so the Playwright configuration can use it as well.
 */

/** Disposable test databases approved for local development. Exact names only. */
export const DISPOSABLE_TEST_DATABASES: readonly string[] = ['aceva_m15_test'];

/** Never reset by a test run, whatever ACEVA_APPROVED_TEST_DATABASES says. */
export const PROTECTED_DATABASES: readonly string[] = ['aceva_dev', 'aceva_shadow', 'aceva_realtime_dev'];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The approved names: the built-in list plus the explicit ACEVA_APPROVED_TEST_DATABASES list. */
export function approvedTestDatabases(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.ACEVA_APPROVED_TEST_DATABASES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set([...DISPOSABLE_TEST_DATABASES, ...extra])];
}

/** The database a connection URL points at. */
export function databaseNameOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid postgresql:// URL.');
  }
  // A database chosen through the query string would bypass the name check below.
  for (const key of parsed.searchParams.keys()) {
    if (['database', 'dbname', 'db'].includes(key.toLowerCase())) {
      throw new Error(`Refusing TEST_DATABASE_URL: it chooses the database with "?${key}=". Put the database name in the path.`);
    }
  }
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

/**
 * Returns the database name when the URL may be emptied by a test run; throws otherwise. Call it before any destructive
 * step, and check the connected database again with assertConnectedTo (the server decides which database it opened).
 */
export function assertDisposableTestDatabase(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const name = databaseNameOf(url);
  const host = new URL(url).hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to run tests against a database on "${host}": test databases must be on this computer (localhost).`);
  }
  if (PROTECTED_DATABASES.includes(name)) {
    throw new Error(`Refusing to run tests against "${name}": it is a protected database and is never reset by tests.`);
  }
  const approved = approvedTestDatabases(env);
  if (!approved.includes(name)) {
    throw new Error(
      `Refusing to run tests against "${name || '(no database name)'}": it is not an approved disposable test database. ` +
        `Approved: ${approved.join(', ')}. Point TEST_DATABASE_URL in backend/.env at one of them ` +
        '(another database only if it is disposable and named in ACEVA_APPROVED_TEST_DATABASES).',
    );
  }
  return name;
}

/** The second check, after connecting: the server must report exactly the database that was approved. */
export async function assertConnectedTo(client: { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> }, expected: string): Promise<void> {
  const { rows } = await client.query('SELECT current_database() AS name');
  const actual = String(rows[0]?.name ?? '');
  if (actual !== expected) {
    throw new Error(`Refusing to reset: connected to "${actual}", but the approved test database is "${expected}".`);
  }
}
