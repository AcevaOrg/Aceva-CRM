import { existsSync, rmSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { E2E_FILES } from './paths';

/**
 * Browser tests for the screens that are connected to the real API (Module 1 now; M2 and M3 later).
 * They start the REAL backend against the aceva_test database (rebuilt and seeded first) and the real
 * Next.js frontend with Module 1 switched to "live". Run from the repository root:  npm run test:e2e
 *
  * People log in through the real login screen (Emp-ID, password, authenticator code) and the API sees their
 * session cookie. Requires PostgreSQL and Redis to be running.
 */
rmSync(E2E_FILES, { recursive: true, force: true }); // uploaded test files belong to one run
if (existsSync('backend/.env')) process.loadEnvFile('backend/.env');
const testDb = process.env.TEST_DATABASE_URL;
if (!testDb || !new URL(testDb).pathname.includes('test')) {
  throw new Error('TEST_DATABASE_URL (a database whose name contains "test") is required for the end-to-end tests');
}

export const API = 'http://localhost:4100/api/v1';

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
      command: 'npx tsx e2e/reset-test-db.ts && npm run build -w backend && node backend/dist/main.js',
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
      },
    },
    {
      command: 'npx next build && npx next start -p 3100',
      cwd: '../frontend',
      url: 'http://localhost:3100/login',
      timeout: 480_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'production', // Playwright sets NODE_ENV=test, which breaks next build
        NEXT_PUBLIC_API_MODE: 'mock',
        NEXT_PUBLIC_LIVE_MODULES: 'm1,m2,m3',
        NEXT_PUBLIC_API_URL: API,
      },
    },
  ],
});
