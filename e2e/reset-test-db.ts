import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../backend/src/generated/prisma/client';
import { seedDevPasswords } from '../backend/prisma/seed-dev-passwords';
import { createFixtureStaff } from '../backend/test/helpers/people';
import { testDatabaseUrl } from '../backend/test/helpers/env';
import { resetTestDatabase, TEST_PASSWORD } from '../backend/test/helpers/reset-db';
import { FIXTURE_CEO, FIXTURE_HR } from './paths';

/**
 * Rebuild and seed the aceva_test database. Runs before the test backend starts.
 * The demo seed has no CEO and no HR officer, so the browser tests add them here, in the test database only.
 */
async function main(): Promise<void> {
  await resetTestDatabase();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });
  try {
    const { CEO, HR } = await createFixtureStaff(prisma);
    if (CEO !== FIXTURE_CEO || HR !== FIXTURE_HR) throw new Error(`Unexpected fixture Emp-IDs: CEO ${CEO}, HR ${HR}`);
    await seedDevPasswords(prisma, TEST_PASSWORD);
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => console.log('aceva_test rebuilt and seeded (with the test-only CEO and HR officer)'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
