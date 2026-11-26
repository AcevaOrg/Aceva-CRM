import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { seedDatabase } from '../../prisma/seed-data';
import { seedDevPasswords } from '../../prisma/seed-dev-passwords';
import { utcPoolConfig } from '../../src/prisma/connection';
import { assertConnectedTo, assertDisposableTestDatabase } from './db-guard';
import { testDatabaseUrl } from './env';

/** The one password every demo person has in the test database. */
export const TEST_PASSWORD = 'Demo-Passw0rd-2026';

/**
 * Empties the test database, re-applies every migration and re-seeds it.
 * Test files that change data call this when they finish so the next file starts clean.
 * Refuses any database that is not an approved disposable test database (db-guard.ts), checked twice: by the name in
 * TEST_DATABASE_URL, and by the database the server says it opened, before anything is dropped.
 */
export async function resetTestDatabase(): Promise<void> {
  const url = testDatabaseUrl();
  const name = assertDisposableTestDatabase(url);
  const client = new Client(utcPoolConfig(url));
  await client.connect();
  try {
    await assertConnectedTo(client, name);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '..', '..'), // the backend folder
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url, SHADOW_DATABASE_URL: '' },
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(utcPoolConfig(url)) });
  try {
    await seedDatabase(prisma);
    await seedDevPasswords(prisma, TEST_PASSWORD); // demo people can log in with one known test password
  } finally {
    await prisma.$disconnect();
  }
}
