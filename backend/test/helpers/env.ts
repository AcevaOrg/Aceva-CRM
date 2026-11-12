import { existsSync } from 'node:fs';

/** Loads backend/.env (when present) and returns the database URL used by automated tests. */
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
  const dbName = new URL(url).pathname.replace('/', '');
  if (!dbName.includes('test')) {
    throw new Error(`Refusing to run tests against "${dbName}": the test database name must contain "test".`);
  }
  return url;
}
