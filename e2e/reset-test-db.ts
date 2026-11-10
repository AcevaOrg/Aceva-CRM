import { resetTestDatabase } from '../backend/test/helpers/reset-db';

/** Rebuild and seed the aceva_test database. Runs before the test backend starts. */
resetTestDatabase()
  .then(() => console.log('aceva_test rebuilt and seeded'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
