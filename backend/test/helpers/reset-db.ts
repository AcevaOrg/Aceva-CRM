import { execSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { seedDatabase } from '../../prisma/seed-data';
import { testDatabaseUrl } from './env';

/**
 * Empties the aceva_test database, re-applies every migration and re-seeds it.
 * Test files that change data call this when they finish so the next file starts clean.
 * Refuses any database whose name does not contain "test" (see testDatabaseUrl).
 */
export async function resetTestDatabase(): Promise<void> {
  const url = testDatabaseUrl();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url, SHADOW_DATABASE_URL: '' },
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    await seedDatabase(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
