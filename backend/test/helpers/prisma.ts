import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { testDatabaseUrl } from './env';

export function createTestPrisma(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });
}

/** Runs `fn` inside a transaction and always rolls it back, so tests leave no data behind. */
export class Rollback extends Error {}

export async function inRolledBackTransaction<T>(
  prisma: PrismaClient,
  fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  try {
    await prisma.$transaction(
      async (tx) => {
        result = await fn(tx);
        throw new Rollback();
      },
      { maxWait: 30_000, timeout: 30_000 }, // many tests at once share a small connection pool
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}
