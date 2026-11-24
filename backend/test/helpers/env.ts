import { existsSync } from 'node:fs';
import { assertDisposableTestDatabase } from './db-guard';

/**
 * Loads backend/.env (when present) and returns the database URL used by automated tests.
 * The URL must name an approved disposable test database (see db-guard.ts); there is no fallback to any other database.
 */
export function testDatabaseUrl(): string {
  // Works from backend/ (unit tests) and from the repository root (Playwright end-to-end tests).
  const envFile = ['.env', 'backend/.env'].find((f) => existsSync(f));
  if (envFile) {
    process.loadEnvFile(envFile); // does not override variables that are already set (CI)
  }
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. Copy backend/.env.example to backend/.env and fill it in.');
  }
  assertDisposableTestDatabase(url);
  return url;
}
