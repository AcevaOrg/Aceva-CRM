import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Prisma } from '../generated/prisma/client';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128; // stops very long inputs from being used to waste server time
export const PASSWORD_HISTORY_DEPTH = 3; // "cannot reuse the last 3 passwords"

/**
 * Passwords (plan section 6):
 *  - stored ONLY as an Argon2id hash. Nobody, including developers, can read a password.
 *  - at least 10 characters
 *  - cannot repeat any of the last 3 passwords
 */
@Injectable()
export class PasswordService {
  private readonly options: { type: typeof argon2.argon2id; memoryCost: number; timeCost: number; parallelism: number };
  private dummyHash?: Promise<string>;

  constructor(@Inject(ENV) env: Env) {
    this.options = {
      type: argon2.argon2id,
      memoryCost: env.ARGON2_MEMORY_KIB,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    };
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, { ...this.options, raw: false });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** True when the stored hash uses weaker settings than today's and should be replaced after a successful login. */
  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, this.options);
  }

  /**
   * Spend the same time as a real check when the Emp-ID does not exist, so response time does not reveal
   * which Emp-IDs are real.
   */
  async burnTime(password: string): Promise<void> {
    this.dummyHash ??= this.hash('not-a-real-password');
    await this.verify(await this.dummyHash, password);
  }

  /** Returns what is wrong with a new password (empty list = acceptable). Does not check reuse. */
  violations(password: string): string[] {
    const problems: string[] = [];
    if (password.length < MIN_PASSWORD_LENGTH) problems.push(`The password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    if (password.length > MAX_PASSWORD_LENGTH) problems.push(`The password must be at most ${MAX_PASSWORD_LENGTH} characters`);
    return problems;
  }

  /** True when the password matches one of the last 3 passwords this person has had (including the current one). */
  async isReused(tx: Prisma.TransactionClient, employeeId: string, password: string): Promise<boolean> {
    const recent = await tx.passwordHistory.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
      take: PASSWORD_HISTORY_DEPTH,
      select: { passwordHash: true },
    });
    for (const row of recent) {
      if (await this.verify(row.passwordHash, password)) return true;
    }
    return false;
  }

  /** A random temporary password (no look-alike characters). Shown once, never stored in plain text. */
  generateTemporaryPassword(length = 14): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
    return out;
  }
}
