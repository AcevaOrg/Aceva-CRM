import { execSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { seedDatabase } from '../prisma/seed-data';
import { testDatabaseUrl } from './helpers/env';

/**
 * Runs once before all tests: empties the aceva_test database, applies every migration from
 * scratch (so the migrations themselves are tested) and loads the seed data.
 *
 * Safety: testDatabaseUrl() refuses any database whose name does not contain "test", so this
 * can never wipe the development database.
 */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  process.env.TEST_DATABASE_URL = url;

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
