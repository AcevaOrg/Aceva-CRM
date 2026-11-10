import { existsSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * DEVELOPMENT AND TESTS ONLY. Gives every demo employee a login with one known password, so people can sign in to
 * the demo data. The password is NOT chosen here: it comes from the DEMO_PASSWORD environment variable
 * (at least 10 characters). The login is not marked "temporary", so the demo people can go straight in.
 * Refuses to run in production. Real employees get a random temporary password from the joining workflow.
 */
export async function seedDevPasswords(prisma: PrismaClient, password: string): Promise<number> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to create demo logins in production.');
  if (password.length < 10) throw new Error('DEMO_PASSWORD must be at least 10 characters.');

  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 65536),
    timeCost: Number(process.env.ARGON2_TIME_COST ?? 3),
    parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
    raw: false,
  });
  const people = await prisma.employee.findMany({ where: { credential: null }, select: { id: true } });
  for (const { id } of people) {
    await prisma.$transaction([
      prisma.credential.create({ data: { employeeId: id, passwordHash: hash, mustChangePassword: false, passwordChangedAt: new Date() } }),
      prisma.passwordHistory.create({ data: { employeeId: id, passwordHash: hash } }),
    ]);
  }
  return people.length;
}

/** Run with:  DEMO_PASSWORD=... npm run db:seed:passwords   (uses DATABASE_URL from backend/.env) */
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const url = process.env.DATABASE_URL;
  const password = process.env.DEMO_PASSWORD;
  if (!url) throw new Error('DATABASE_URL is not set');
  if (!password) throw new Error('Set DEMO_PASSWORD (at least 10 characters) to the password you want the demo people to use.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    console.log(`Created ${await seedDevPasswords(prisma, password)} demo login(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.includes('seed-dev-passwords')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
