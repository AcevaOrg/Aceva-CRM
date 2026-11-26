import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the frontend's pure rules (no browser, no server): `npm test -w frontend`.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // The first import of a module chain (date-fns, the API client) is slow on a cold start.
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 30_000 },
});
