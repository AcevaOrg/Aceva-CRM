import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../backend/src/generated/prisma/client';
import { seedDevPasswords } from '../backend/prisma/seed-dev-passwords';
import { createFixtureStaff } from '../backend/test/helpers/people';
import { testDatabaseUrl } from '../backend/test/helpers/env';
import { resetTestDatabase, TEST_PASSWORD } from '../backend/test/helpers/reset-db';
import { FIXTURE_HR } from './paths';

/**
 * Rebuild and seed the aceva_test database. Runs before the test backend starts.
 * The demo seed has no separate HR officer (the Director holds HR duty), so the browser tests add one here, in the test
 * database only.
 */
async function main(): Promise<void> {
  await resetTestDatabase();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });
  try {
    const { HR } = await createFixtureStaff(prisma);
    if (HR !== FIXTURE_HR) throw new Error(`Unexpected fixture Emp-ID: HR ${HR}`);
    await seedDevPasswords(prisma, TEST_PASSWORD);
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => console.log('aceva_test rebuilt and seeded (with the test-only HR officer)'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
