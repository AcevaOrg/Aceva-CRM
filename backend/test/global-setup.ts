import { testDatabaseUrl } from './helpers/env';
import { resetTestDatabase } from './helpers/reset-db';
import { switchOffBackgroundWork } from './helpers/quiet-env';

/**
 * Runs once before all tests: empties the aceva_test database, applies every migration from
 * scratch (so the migrations themselves are tested) and loads the seed data.
 */
export default async function setup(): Promise<void> {
  process.env.TEST_DATABASE_URL = testDatabaseUrl();
  // Every test file starts the app (or a part of it) against this database: no file may leave background jobs in it.
  switchOffBackgroundWork();
  await resetTestDatabase();
}
