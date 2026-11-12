import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock';
import { PrismaService } from '../prisma/prisma.service';

/** Too many failed logins from one internet address: first slow down, then block for a while. */
export const SLOW_AFTER_FAILURES = 5; // within SLOW_WINDOW_MS
export const SLOW_WINDOW_MS = 5 * 60_000;
export const SLOW_STEP_MS = 500;
export const SLOW_MAX_MS = 5_000;
export const BLOCK_AFTER_FAILURES = 15; // within BLOCK_WINDOW_MS
export const BLOCK_WINDOW_MS = 15 * 60_000;

export interface ThrottleDecision {
  blocked: boolean;
  retryAfterSec?: number;
  /** How long to wait before answering (slows down guessing). */
  delayMs: number;
}

export interface AttemptRecord {
  empIdAttempted: string;
  employeeId: string | null;
  ip: string;
  userAgent: string | null;
  success: boolean;
  failureReason?: string;
}

/**
 * Per-address login rate limiting, based on the login_attempts table (permanent, and the same record
 * Module 4 and the audit trail rely on). Attempts that were themselves turned away ("rate_limited") are not
 * counted, so an attacker who keeps knocking cannot extend their own block forever.
 */
@Injectable()
export class LoginThrottleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async check(ip: string): Promise<ThrottleDecision> {
    const now = this.clock.now().getTime();
    const failures = await this.prisma.loginAttempt.findMany({
      where: {
        ip,
        success: false,
        createdAt: { gte: new Date(now - BLOCK_WINDOW_MS) },
        NOT: { failureReason: 'rate_limited' },
      },
      orderBy: { createdAt: 'desc' },
      take: BLOCK_AFTER_FAILURES,
      select: { createdAt: true },
    });

    if (failures.length >= BLOCK_AFTER_FAILURES) {
      // Blocked until the 15th most recent failure is 15 minutes old.
      const until = failures[BLOCK_AFTER_FAILURES - 1].createdAt.getTime() + BLOCK_WINDOW_MS;
      return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((until - now) / 1000)), delayMs: 0 };
    }
    const recent = failures.filter((f) => f.createdAt.getTime() >= now - SLOW_WINDOW_MS).length;
    const delayMs = recent >= SLOW_AFTER_FAILURES ? Math.min((recent - SLOW_AFTER_FAILURES + 1) * SLOW_STEP_MS, SLOW_MAX_MS) : 0;
    return { blocked: false, delayMs };
  }

  async record(attempt: AttemptRecord): Promise<void> {
    await this.prisma.loginAttempt.create({
      data: {
        empIdAttempted: attempt.empIdAttempted.slice(0, 40),
        employeeId: attempt.employeeId,
        ip: attempt.ip,
        userAgent: attempt.userAgent?.slice(0, 300) ?? null,
        success: attempt.success,
        failureReason: attempt.failureReason ?? null,
        createdAt: this.clock.now(),
      },
    });
  }

  /** Wrong authenticator codes for one person in the last 15 minutes. */
  async recentTwoFactorFailures(employeeId: string): Promise<number> {
    return this.prisma.loginAttempt.count({
      where: {
        employeeId,
        failureReason: 'two_factor_failed',
        createdAt: { gte: new Date(this.clock.now().getTime() - BLOCK_WINDOW_MS) },
      },
    });
  }
}
