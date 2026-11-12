import { testDatabaseUrl } from './helpers/env';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Runs once before all tests: empties the aceva_test database, applies every migration from
 * scratch (so the migrations themselves are tested) and loads the seed data.
 */
export default async function setup(): Promise<void> {
  process.env.TEST_DATABASE_URL = testDatabaseUrl();
  await resetTestDatabase();
}
