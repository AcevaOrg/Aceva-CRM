import { existsSync, rmSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { assertDisposableTestDatabase } from '../backend/test/helpers/db-guard';
import { E2E_FILES } from './paths';

/**
 * Browser tests for the screens that are connected to the real API (Module 1 now; M2 and M3 later).
 * They start the REAL backend against the approved disposable test database (rebuilt and seeded first) and the real
 * Next.js frontend with Module 1 switched to "live". Run from the repository root:  npm run test:e2e
 *
  * People log in through the real login screen (Emp-ID, password, authenticator code) and the API sees their
 * session cookie. Requires PostgreSQL and Redis to be running.
 */
rmSync(E2E_FILES, { recursive: true, force: true }); // uploaded test files belong to one run
if (existsSync('backend/.env')) process.loadEnvFile('backend/.env');
const testDb = process.env.TEST_DATABASE_URL;
if (!testDb) {
  throw new Error('TEST_DATABASE_URL (an approved disposable test database) is required for the end-to-end tests');
}
// The browser run rebuilds this database: only an approved disposable test database, never a fallback (db-guard.ts).
assertDisposableTestDatabase(testDb);

export const API = 'http://localhost:4100/api/v1';

/**
 * PW_PREBUILT=1: the backend (npm run build -w backend) and the frontend (next build, with the NEXT_PUBLIC_* values
 * below) were built beforehand, so the servers only reset the test database and start. Both builds at the same time
 * (the default) need a lot of memory at once; on a machine short of memory, build first, one after the other.
 */
const PREBUILT = process.env.PW_PREBUILT === '1';

// Saved logins and authenticator secrets belong to ONE run (the database is rebuilt for every run).
if (!process.env.PW_E2E_RUN) {
  process.env.PW_E2E_RUN = String(Date.now());
  rmSync('e2e/.auth', { recursive: true, force: true });
}

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3100', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    {
      command: PREBUILT ? 'npx tsx e2e/reset-test-db.ts && node backend/dist/main.js' : 'npx tsx e2e/reset-test-db.ts && npm run build -w backend && node backend/dist/main.js',
      cwd: '..',
      url: `${API}/health`,
      timeout: 240_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test',
        PORT: '4100',
        DATABASE_URL: testDb,
        CORS_ORIGIN: 'http://localhost:3100',
        REDIS_KEY_PREFIX: 'aceva:e2e:',
        FILE_STORAGE_ROOT: E2E_FILES,
        TRUST_PROXY: '0',
        // Cycle 3 foundation: the outbox reader and the notification emails run on their own timers, as in production.
        BACKGROUND_WORKERS: 'on',
      },
    },
    {
      command: PREBUILT ? 'npx next start -p 3100' : 'npx next build && npx next start -p 3100',
      cwd: '../frontend',
      url: 'http://localhost:3100/login',
      timeout: 480_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'production', // Playwright sets NODE_ENV=test, which breaks next build
        NEXT_PUBLIC_API_MODE: 'mock',
        NEXT_PUBLIC_LIVE_MODULES: 'm1,m2,m3,m5,m6,m7,m8,m9,m12,m13,m14,m15',
        NEXT_PUBLIC_API_URL: API,
      },
    },
  ],
});
