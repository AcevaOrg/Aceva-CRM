import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * Browser tests for the screens that are connected to the real API (Module 1 now; M2 and M3 later).
 * They start the REAL backend against the aceva_test database (rebuilt and seeded first) and the real
 * Next.js frontend with Module 1 switched to "live". Run from the repository root:  npm run test:e2e
 *
 * Until M2 (real login) exists, the browser identifies itself to the API with the development-only
 * X-Dev-Emp-Id header (NEXT_PUBLIC_DEV_IDENTITY / DEV_IDENTITY_ENABLED). That is not security.
 */
if (existsSync('backend/.env')) process.loadEnvFile('backend/.env');
const testDb = process.env.TEST_DATABASE_URL;
if (!testDb || !new URL(testDb).pathname.includes('test')) {
  throw new Error('TEST_DATABASE_URL (a database whose name contains "test") is required for the end-to-end tests');
}

export const API = 'http://localhost:4100/api/v1';

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
        DEV_IDENTITY_ENABLED: 'true',
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
        NEXT_PUBLIC_LIVE_MODULES: 'm1',
        NEXT_PUBLIC_DEV_IDENTITY: 'true',
        NEXT_PUBLIC_API_URL: API,
      },
    },
  ],
});
