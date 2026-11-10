import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  ChangePasswordRequest,
  DisableTwoFactorRequest,
  ForgotPasswordRequest,
  LoginHistoryItem,
  LoginRequest,
  LoginResult,
  LogoutReason,
  MeResponse,
  ResetPasswordRequest,
  SessionInfo,
  TwoFactorSetupResponse,
  TwoFactorStatus,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { Clock } from '../common/clock';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { OutboxService } from '../events/outbox.service';
import { Prisma } from '../generated/prisma/client';
import type { SessionStage } from '../identity/identity.provider';
import { Mailer } from '../mail/mailer';
import { PrismaService } from '../prisma/prisma.service';
import { AuthStateService } from './auth-state.service';
import { CryptoService } from './crypto.service';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordService } from './password.service';
import { EndReason, SessionService } from './session/session.service';
import { TotpService } from './totp.service';

/** Wrong passwords before the account locks (plan section 6). */
export const MAX_FAILED_PASSWORDS = 5;
export const RESET_LINK_MINUTES = 15;
const RESET_REQUESTS_PER_HOUR = 3;
const MAX_WRONG_CODES = 5;
const OFFICIAL_EMAIL_DOMAIN = '@acevatech.com';

/** What the controller needs to set (or clear) the session cookie. */
export interface IssuedSession {
  token: string;
  csrfToken: string;
  rememberMe: boolean;
  absoluteExpiresAt: number;
}

type FailureReason = 'invalid_credentials' | 'locked' | 'rate_limited' | 'two_factor_failed' | 'disabled';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Employee ID login (plan section 6): password, optional or mandatory authenticator code, lockout after five
 * wrong passwords, secure password reset, forced logout, and the events Module 4 will read.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly crypto: CryptoService,
    private readonly totp: TotpService,
    private readonly sessions: SessionService,
    private readonly throttle: LoginThrottleService,
    private readonly state: AuthStateService,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ===================================================================== login

  async login(dto: LoginRequest, client: RequestInfo): Promise<{ result: LoginResult; session?: IssuedSession }> {
    const ip = client.ip ?? 'unknown';
    const now = this.clock.now();

    // Per-address rate limit: slow down, then block for a while.
    const decision = await this.throttle.check(ip);
    if (decision.blocked) {
      await this.recordFailure(dto.empId, null, client, 'rate_limited');
      return { result: { status: 'rate_limited', retryAfterSec: decision.retryAfterSec } };
    }
    if (decision.delayMs) await sleep(decision.delayMs);

    const employee = await this.prisma.employee.findUnique({
      where: { empId: dto.empId },
      select: {
        id: true,
        empId: true,
        status: true,
        credential: { select: { passwordHash: true, lockedAt: true, loginDisabledAt: true } },
      },
    });

    // Unknown Emp-ID or no credential: take the same time as a real check and say nothing useful.
    if (!employee || !employee.credential) {
      await this.passwords.burnTime(dto.password);
      await this.recordFailure(dto.empId, null, client, 'invalid_credentials');
      return { result: { status: 'invalid' } };
    }
    if (employee.status === 'left' || employee.credential.loginDisabledAt) {
      await this.passwords.burnTime(dto.password);
      await this.recordFailure(dto.empId, employee, client, 'disabled');
      return { result: { status: 'invalid' } };
    }
    if (employee.credential.lockedAt) {
      await this.recordFailure(dto.empId, employee, client, 'locked');
      return { result: { status: 'locked' } };
    }

    if (!(await this.passwords.verify(employee.credential.passwordHash, dto.password))) {
      // Count atomically, so several simultaneous wrong guesses cannot slip past the limit.
      const rows = await this.prisma.$queryRaw<Array<{ failed_attempts: number; locked_at: Date | null }>>`
        UPDATE credentials
        SET failed_attempts = failed_attempts + 1,
            locked_at = CASE WHEN failed_attempts + 1 >= ${MAX_FAILED_PASSWORDS} AND locked_at IS NULL THEN ${now} ELSE locked_at END,
            updated_at = ${now}
        WHERE employee_id = ${employee.id}::uuid
        RETURNING failed_attempts, locked_at`;
      const nowLocked = rows[0]?.locked_at !== null && (rows[0]?.failed_attempts ?? 0) >= MAX_FAILED_PASSWORDS;
      if (nowLocked) {
        await this.audit.record({
          actorId: null,
          action: 'auth.account.locked',
          targetType: 'employee',
          targetId: employee.empId,
          reason: `${MAX_FAILED_PASSWORDS} wrong passwords`,
          details: { failedAttempts: rows[0].failed_attempts },
          ...client,
        });
      }
      await this.recordFailure(dto.empId, employee, client, nowLocked ? 'locked' : 'invalid_credentials');
      // The number of attempts left is not revealed (it would show which Emp-IDs are real).
      return { result: { status: nowLocked ? 'locked' : 'invalid' } };
    }

    // Correct password.
    await this.prisma.credential.update({ where: { employeeId: employee.id }, data: { failedAttempts: 0 } });
    if (this.passwords.needsRehash(employee.credential.passwordHash)) {
      await this.prisma.credential.update({ where: { employeeId: employee.id }, data: { passwordHash: await this.passwords.hash(dto.password) } });
    }
    const authState = await this.state.get(employee.id);
    if (!authState) return { result: { status: 'invalid' } };

    const rememberMe = !!dto.rememberMe && !authState.hasFinanceDuty; // no "remember me" for finance users
    const issued = await this.sessions.create({
      employeeId: employee.id,
      empId: employee.empId,
      rememberMe,
      twoFactorVerified: false,
      ip,
      userAgent: client.userAgent,
    });
    await this.throttle.record({ empIdAttempted: dto.empId, employeeId: employee.id, ip, userAgent: client.userAgent, success: true });
    await this.outbox.emit({
      type: 'auth.login',
      actor: employee.empId as `ACV-${string}`,
      payload: { empId: employee.empId, sessionId: issued.session.id, ip, userAgent: client.userAgent?.slice(0, 300) ?? null },
    });

    const stage = this.state.stage(authState, false);
    return {
      result: { status: stage === 'ok' ? 'ok' : stage },
      session: { token: issued.token, csrfToken: issued.csrfToken, rememberMe, absoluteExpiresAt: issued.session.absoluteExpiresAt },
    };
  }

  private async recordFailure(empIdAttempted: string, employee: { id: string; empId: string } | null, client: RequestInfo, reason: FailureReason): Promise<void> {
    const ip = client.ip ?? 'unknown';
    await this.throttle.record({ empIdAttempted, employeeId: employee?.id ?? null, ip, userAgent: client.userAgent, success: false, failureReason: reason });
    await this.outbox.emit({
      type: 'auth.login_failed',
      actor: (employee?.empId as `ACV-${string}` | undefined) ?? 'system',
      payload: { empIdAttempted: empIdAttempted.slice(0, 40), empId: (employee?.empId as `ACV-${string}` | undefined) ?? null, reason, ip, userAgent: client.userAgent?.slice(0, 300) ?? null },
    });
  }

  // ===================================================================== who am I

  async me(actor: Actor, sessionToken: string | null, stage: SessionStage): Promise<MeResponse> {
    const access = await this.permissions.getEffectiveAccess(actor.id);
    const authState = await this.state.get(actor.id);
    return {
      empId: actor.empId,
      name: actor.fullName,
      level: actor.levelNumber,
      roleKey: actor.roleKey,
      duties: access.duties,
      permissions: [...access.permissions].sort(),
      twoFactorRequired: access.twoFactorRequired,
      twoFactorEnabled: !!authState?.twoFactorEnabled,
      stage,
      csrfToken: sessionToken ? this.crypto.csrfTokenFor(sessionToken) : '',
      rememberAllowed: !authState?.hasFinanceDuty,
    };
  }

  // ===================================================================== two-step login (TOTP)

  /** Starts setting up an authenticator app. The secret is shown once and stored encrypted. */
  async twoFactorSetup(actor: Actor): Promise<TwoFactorSetupResponse> {
    const existing = await this.prisma.totpSecret.findUnique({ where: { employeeId: actor.id }, select: { confirmedAt: true } });
    if (existing?.confirmedAt) throw new ConflictException({ statusCode: 409, code: 'already_enabled', message: 'Two-step login is already set up' });
    const secret = this.totp.newSecret();
    const data = { secretEncrypted: this.crypto.encrypt(secret), keyId: 'v1', confirmedAt: null, lastUsedStep: null, updatedBy: actor.id };
    await this.prisma.totpSecret.upsert({ where: { employeeId: actor.id }, update: data, create: { employeeId: actor.id, createdBy: actor.id, ...data } });
    return { secret, otpauthUrl: this.totp.otpauthUrl(actor.empId, secret) };
  }

  /**
   * Checks the 6-digit code on the server. The first correct code also confirms the set-up.
   * Five wrong codes end the session; the same code cannot be used twice.
   */
  async twoFactorVerify(actor: Actor, sessionId: string, code: string, client: RequestInfo): Promise<{ stage: SessionStage }> {
    const row = await this.prisma.totpSecret.findUnique({ where: { employeeId: actor.id } });
    if (!row) throw new BadRequestException({ statusCode: 400, code: 'two_factor_not_set_up', message: 'Set up the authenticator app first' });

    const now = this.clock.now();
    const check = this.totp.verify(this.crypto.decrypt(row.secretEncrypted), code, now, row.lastUsedStep === null ? null : Number(row.lastUsedStep));
    const claimed =
      check.valid &&
      (
        await this.prisma.totpSecret.updateMany({
          where: { employeeId: actor.id, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: check.step! } }] },
          data: { lastUsedStep: check.step!, ...(row.confirmedAt ? {} : { confirmedAt: now }) },
        })
      ).count > 0;

    if (!claimed) {
      await this.recordFailure(actor.empId, { id: actor.id, empId: actor.empId }, client, 'two_factor_failed');
      if ((await this.throttle.recentTwoFactorFailures(actor.id)) >= MAX_WRONG_CODES) {
        await this.audit.record({ actorId: actor.id, action: 'auth.2fa.too_many_failures', targetType: 'employee', targetId: actor.empId, outcome: 'denied', ...client });
        await this.sessions.end(sessionId, 'forced');
        throw new ForbiddenException({ statusCode: 403, code: 'too_many_wrong_codes', message: 'Too many wrong codes. Please log in again.' });
      }
      throw new BadRequestException({ statusCode: 400, code: 'invalid_code', message: 'That code is not right. Try the current code from your app.' });
    }
    if (!row.confirmedAt) {
      await this.prisma.credential.updateMany({ where: { employeeId: actor.id }, data: { mustEnrollTwoFactor: false } });
      await this.audit.record({ actorId: actor.id, action: 'auth.2fa.enabled', targetType: 'employee', targetId: actor.empId, ...client });
    }
    await this.sessions.markTwoFactorVerified(sessionId);
    const state = await this.state.get(actor.id);
    return { stage: state ? this.state.stage(state, true) : 'ok' };
  }

  /** Switch two-step login off. Only possible where it is optional, and needs the password and a current code. */
  async twoFactorDisable(actor: Actor, dto: DisableTwoFactorRequest, client: RequestInfo): Promise<void> {
    const state = await this.state.get(actor.id);
    if (!state) throw new NotFoundException('Employee not found');
    if (state.twoFactorRequired) {
      throw new ForbiddenException({ statusCode: 403, code: 'two_factor_required', message: 'Two-step login is required for your level or duty' });
    }
    const credential = await this.prisma.credential.findUnique({ where: { employeeId: actor.id }, select: { passwordHash: true } });
    const row = await this.prisma.totpSecret.findUnique({ where: { employeeId: actor.id } });
    const codeOk = row ? this.totp.verify(this.crypto.decrypt(row.secretEncrypted), dto.code, this.clock.now(), row.lastUsedStep === null ? null : Number(row.lastUsedStep)).valid : false;
    if (!credential || !row || !codeOk || !(await this.passwords.verify(credential.passwordHash, dto.password))) {
      throw new BadRequestException({ statusCode: 400, code: 'invalid_credentials', message: 'The password or the code is not right' });
    }
    await this.prisma.totpSecret.delete({ where: { employeeId: actor.id } });
    await this.audit.record({ actorId: actor.id, action: 'auth.2fa.disabled', targetType: 'employee', targetId: actor.empId, ...client });
  }

  async twoFactorStatus(actor: Actor): Promise<TwoFactorStatus> {
    const [state, row] = await Promise.all([
      this.state.get(actor.id),
      this.prisma.totpSecret.findUnique({ where: { employeeId: actor.id }, select: { confirmedAt: true } }),
    ]);
    return { required: !!state?.twoFactorRequired, enabled: !!row?.confirmedAt, enabledAt: row?.confirmedAt?.toISOString() };
  }

  // ===================================================================== passwords

  /**
   * Sets a new password: at least 10 characters, not one of the last 3. All sessions on every device end at
   * once; the current device gets a fresh session so the person stays logged in.
   */
  async changePassword(actor: Actor, sessionId: string, dto: ChangePasswordRequest, client: RequestInfo): Promise<{ session: IssuedSession; stage: SessionStage }> {
    const credential = await this.prisma.credential.findUnique({ where: { employeeId: actor.id }, select: { passwordHash: true, mustChangePassword: true } });
    if (!credential) throw new NotFoundException('No login for this employee');

    // A normal change proves the current password; a first-login change already did (the temporary password).
    if (!credential.mustChangePassword) {
      if (!dto.currentPassword || !(await this.passwords.verify(credential.passwordHash, dto.currentPassword))) {
        throw new BadRequestException({ statusCode: 400, code: 'wrong_current_password', message: 'The current password is not right' });
      }
    } else if (dto.currentPassword && !(await this.passwords.verify(credential.passwordHash, dto.currentPassword))) {
      throw new BadRequestException({ statusCode: 400, code: 'wrong_current_password', message: 'The current password is not right' });
    }

    await this.setPassword(actor.id, dto.newPassword, { mustChange: false, actorId: actor.id });
    const previous = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { twoFactorVerifiedAt: true, rememberMe: true } });
    await this.sessions.endAllFor(actor.id, 'password_changed');
    await this.audit.record({ actorId: actor.id, action: 'auth.password.changed', targetType: 'employee', targetId: actor.empId, ...client });

    const issued = await this.sessions.create({
      employeeId: actor.id,
      empId: actor.empId,
      rememberMe: previous?.rememberMe ?? false,
      twoFactorVerified: !!previous?.twoFactorVerifiedAt,
      ip: client.ip,
      userAgent: client.userAgent,
    });
    const state = await this.state.get(actor.id);
    return {
      session: { token: issued.token, csrfToken: issued.csrfToken, rememberMe: issued.session.rememberMe, absoluteExpiresAt: issued.session.absoluteExpiresAt },
      stage: state ? this.state.stage(state, issued.session.twoFactorVerified) : 'ok',
    };
  }

  /**
   * Validates and stores a password (Argon2id hash only) and remembers it in the history.
   * Throws a 400 for a short password or a reused one.
   */
  async setPassword(employeeId: string, password: string, options: { mustChange: boolean; actorId: string | null; unlock?: boolean }): Promise<void> {
    const problems = this.passwords.violations(password);
    if (problems.length) throw new BadRequestException({ statusCode: 400, code: 'weak_password', message: problems.join('. '), violations: problems });
    const hash = await this.passwords.hash(password);
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      if (await this.passwords.isReused(tx, employeeId, password)) {
        throw new BadRequestException({ statusCode: 400, code: 'password_reused', message: 'You cannot reuse any of your last 3 passwords' });
      }
      await this.writeCredential(tx, employeeId, hash, now, options);
    });
  }

  /** Creates or replaces the credential row and adds the new hash to the history. */
  private async writeCredential(tx: Prisma.TransactionClient, employeeId: string, hash: string, now: Date, options: { mustChange: boolean; actorId: string | null }): Promise<void> {
    await tx.credential.upsert({
      where: { employeeId },
      update: { passwordHash: hash, mustChangePassword: options.mustChange, passwordChangedAt: now, failedAttempts: 0, updatedBy: options.actorId },
      create: { employeeId, passwordHash: hash, mustChangePassword: options.mustChange, passwordChangedAt: now, createdBy: options.actorId },
    });
    await tx.passwordHistory.create({ data: { employeeId, passwordHash: hash, createdAt: now, createdBy: options.actorId } });
  }

  /**
   * Creates the login of a new employee with a temporary password that must be changed at first login.
   * Used by the employee joining workflow (Module 3). Returns the temporary password once.
   */
  async provisionCredential(employeeId: string, actorId: string | null, password?: string, tx?: Prisma.TransactionClient): Promise<string> {
    const temporary = password ?? this.passwords.generateTemporaryPassword();
    const hash = await this.passwords.hash(temporary);
    const run = (client: Prisma.TransactionClient) => this.writeCredential(client, employeeId, hash, this.clock.now(), { mustChange: true, actorId });
    if (tx) await run(tx);
    else await this.prisma.$transaction(run);
    return temporary;
  }

  /** Sends a one-time reset link to the official acevatech.com address. Always answers the same way. */
  async forgotPassword(dto: ForgotPasswordRequest, client: RequestInfo): Promise<void> {
    const now = this.clock.now();
    const employee = await this.prisma.employee.findUnique({
      where: { empId: dto.empId },
      select: { id: true, empId: true, fullName: true, status: true, officialEmail: true, credential: { select: { loginDisabledAt: true } } },
    });
    const email = employee?.officialEmail?.toLowerCase();
    if (!employee || !employee.credential || employee.credential.loginDisabledAt || employee.status === 'left' || !email?.endsWith(OFFICIAL_EMAIL_DOMAIN)) {
      return; // no official email: the Director or HR sets a temporary password instead
    }
    const recent = await this.prisma.passwordResetToken.count({ where: { employeeId: employee.id, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
    if (recent >= RESET_REQUESTS_PER_HOUR) return; // quietly limit mail-bombing

    const token = this.crypto.randomToken(32);
    await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({ where: { employeeId: employee.id, usedAt: null }, data: { usedAt: now } }); // older links stop working
      await tx.passwordResetToken.create({
        data: { employeeId: employee.id, tokenHash: this.crypto.sha256(token), expiresAt: new Date(now.getTime() + RESET_LINK_MINUTES * 60_000), createdAt: now },
      });
    });
    await this.audit.record({ actorId: null, action: 'auth.password.reset_requested', targetType: 'employee', targetId: employee.empId, ...client });

    const link = `${this.env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    try {
      await this.mailer.send({
        to: email,
        subject: 'Reset your Aceva password',
        text: `Hello ${employee.fullName},\n\nUse this link to choose a new password. It works once and expires in ${RESET_LINK_MINUTES} minutes:\n\n${link}\n\nIf you did not ask for this, you can ignore this email. Your password has not changed.`,
        html: `<p>Hello ${escapeHtml(employee.fullName)},</p><p>Use this link to choose a new password. It works once and expires in ${RESET_LINK_MINUTES} minutes:</p><p><a href="${link}">Choose a new password</a></p><p>If you did not ask for this, you can ignore this email. Your password has not changed.</p>`,
      });
    } catch {
      // Already logged by the mailer. The person simply asks again; nothing is revealed here.
    }
  }

  /** Uses a reset link once. Ends every session of the person. */
  async resetPassword(dto: ResetPasswordRequest, client: RequestInfo): Promise<void> {
    const now = this.clock.now();
    const tokenHash = this.crypto.sha256(dto.token);
    const invalid = () => new BadRequestException({ statusCode: 400, code: 'invalid_or_expired_link', message: 'This link is not valid any more. Ask for a new one.' });

    const row = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash }, select: { employeeId: true, usedAt: true, expiresAt: true, employee: { select: { empId: true } } } });
    if (!row || row.usedAt || row.expiresAt <= now) throw invalid();

    const problems = this.passwords.violations(dto.newPassword);
    if (problems.length) throw new BadRequestException({ statusCode: 400, code: 'weak_password', message: problems.join('. '), violations: problems });

    const hash = await this.passwords.hash(dto.newPassword);
    await this.prisma.$transaction(async (tx) => {
      if (await this.passwords.isReused(tx, row.employeeId, dto.newPassword)) {
        throw new BadRequestException({ statusCode: 400, code: 'password_reused', message: 'You cannot reuse any of your last 3 passwords' });
      }
      // Single use: only one request can claim the link, even if two arrive together.
      const claimed = await tx.passwordResetToken.updateMany({ where: { tokenHash, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (claimed.count === 0) throw invalid();
      await this.writeCredential(tx, row.employeeId, hash, now, { mustChange: false, actorId: row.employeeId });
    });
    await this.sessions.endAllFor(row.employeeId, 'password_changed');
    await this.audit.record({ actorId: null, action: 'auth.password.reset', targetType: 'employee', targetId: row.employee.empId, ...client });
  }

  // ===================================================================== administration

  /** A higher level (above them in the reporting line) or HR unlocks a locked account. */
  async unlock(actor: Actor, targetEmpId: string, reason: string | undefined, client: RequestInfo): Promise<void> {
    const target = await this.requireTarget(targetEmpId);
    const isHr = (await this.permissions.getEffectiveAccess(actor.id)).duties.includes('hr');
    if (!isHr && !(await this.scope.canAccess(actor.id, target.id, 'below'))) {
      await this.denyAdmin(actor, 'auth.account.unlock', target.empId, client);
    }
    const { count } = await this.prisma.credential.updateMany({ where: { employeeId: target.id, lockedAt: { not: null } }, data: { lockedAt: null, failedAttempts: 0, updatedBy: actor.id } });
    if (count === 0) throw new ConflictException({ statusCode: 409, code: 'not_locked', message: 'This account is not locked' });
    await this.audit.record({ actorId: actor.id, action: 'auth.account.unlocked', targetType: 'employee', targetId: target.empId, reason: reason ?? null, details: { byHrDuty: isHr }, ...client });
  }

  /** An administrator ends every session of someone below them, on every device, at once. */
  async forceLogout(actor: Actor, targetEmpId: string, reason: string | undefined, client: RequestInfo): Promise<{ ended: number }> {
    const target = await this.requireTarget(targetEmpId);
    if (!(await this.scope.canAccess(actor.id, target.id, 'below'))) await this.denyAdmin(actor, 'auth.session.force_logout', target.empId, client);
    const ended = await this.sessions.endAllFor(target.id, 'forced');
    await this.audit.record({ actorId: actor.id, action: 'auth.session.forced_logout', targetType: 'employee', targetId: target.empId, reason: reason ?? null, details: { ended }, ...client });
    return { ended };
  }

  /**
   * Director or HR: a temporary password for someone WITHOUT an official email (people with one use the reset link).
   * Returned once, never stored in plain text; it must be changed at the next login.
   */
  async setTemporaryPassword(actor: Actor, targetEmpId: string, reason: string | undefined, client: RequestInfo): Promise<{ temporaryPassword: string }> {
    const target = await this.prisma.employee.findUnique({
      where: { empId: targetEmpId },
      select: { id: true, empId: true, status: true, officialEmail: true, level: { select: { number: true } } },
    });
    if (!target) throw new NotFoundException('Employee not found');
    // Only for people of a lower rank, or below you in the reporting line (nobody resets a superior).
    const lowerRank = target.level.number > actor.levelNumber;
    if (target.id === actor.id || !(lowerRank || (await this.scope.canAccess(actor.id, target.id, 'below')))) {
      await this.denyAdmin(actor, 'auth.set_temporary_password', target.empId, client);
    }
    if (target.status === 'left') throw new BadRequestException({ statusCode: 400, code: 'employee_left', message: 'This employee has left the company' });
    if (target.officialEmail?.toLowerCase().endsWith(OFFICIAL_EMAIL_DOMAIN)) {
      throw new ConflictException({ statusCode: 409, code: 'has_official_email', message: 'This person has an official email: send them a reset link instead' });
    }
    const temporary = this.passwords.generateTemporaryPassword();
    const hash = await this.passwords.hash(temporary);
    await this.prisma.$transaction((tx) => this.writeCredential(tx, target.id, hash, this.clock.now(), { mustChange: true, actorId: actor.id }));
    await this.sessions.endAllFor(target.id, 'password_changed');
    await this.audit.record({ actorId: actor.id, action: 'auth.password.temporary_set', targetType: 'employee', targetId: target.empId, reason: reason ?? null, ...client });
    return { temporaryPassword: temporary };
  }

  /**
   * Lost authenticator phone. Owner and CEO may reset anyone of lower rank; the Director anyone below them in the
   * reporting chain; HR duty people of lower rank. Never oneself, never the same level, never upward.
   * The old secret is destroyed, every session ends, and a fresh authenticator must be set up at the next login.
   */
  async resetTwoFactor(actor: Actor, targetEmpId: string, reason: string, client: RequestInfo): Promise<{ ended: number }> {
    const target = await this.prisma.employee.findUnique({ where: { empId: targetEmpId }, select: { id: true, empId: true, status: true, level: { select: { number: true } } } });
    if (!target) throw new NotFoundException('Employee not found');
    const access = await this.permissions.getEffectiveAccess(actor.id);
    const lowerRank = target.level.number > actor.levelNumber; // strictly lower: never self, same level or upward
    const byOwnerOrCeo = actor.levelNumber <= 2;
    const byDirector = actor.roleKey === 'director' && (await this.scope.canAccess(actor.id, target.id, 'below'));
    const byHr = access.duties.includes('hr');
    const allowed = target.id !== actor.id && lowerRank && (byOwnerOrCeo || byDirector || byHr);
    if (!allowed) await this.denyAdmin(actor, 'auth.reset_two_factor', target.empId, client);
    if (target.status === 'left') throw new BadRequestException({ statusCode: 400, code: 'employee_left', message: 'This employee has left the company' });

    await this.prisma.$transaction(async (tx) => {
      await tx.totpSecret.deleteMany({ where: { employeeId: target.id } }); // the old authenticator secret is destroyed
      await tx.credential.updateMany({ where: { employeeId: target.id }, data: { mustEnrollTwoFactor: true, updatedBy: actor.id } });
    });
    const ended = await this.sessions.endAllFor(target.id, 'forced');
    await this.audit.record({
      actorId: actor.id,
      action: 'auth.2fa.reset',
      targetType: 'employee',
      targetId: target.empId,
      reason,
      details: { ended, rule: byOwnerOrCeo ? 'owner_or_ceo' : byDirector ? 'director' : 'hr_duty' },
      ...client,
    });
    return { ended };
  }

  /** Called when an employee's last working day is processed (Module 3): no more logins, all sessions end. */
  async disableLogin(employeeId: string, actorId: string | null): Promise<void> {
    await this.prisma.credential.updateMany({ where: { employeeId }, data: { loginDisabledAt: this.clock.now(), updatedBy: actorId } });
    await this.sessions.endAllFor(employeeId, 'employee_left');
  }

  private async requireTarget(empId: string) {
    const target = await this.prisma.employee.findUnique({ where: { empId }, select: { id: true, empId: true } });
    if (!target) throw new NotFoundException('Employee not found');
    return target;
  }

  private async denyAdmin(actor: Actor, action: string, targetEmpId: string, client: RequestInfo): Promise<never> {
    await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'employee', targetId: targetEmpId, outcome: 'denied', reason: 'out_of_scope', details: { attempted: action }, ...client });
    throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'You do not have access to this' });
  }

  // ===================================================================== sessions: logout, My devices, history

  async logout(sessionId: string | null, reason: EndReason = 'user'): Promise<void> {
    if (sessionId) await this.sessions.end(sessionId, reason);
  }

  async listSessions(actor: Actor, currentSessionId: string | null): Promise<SessionInfo[]> {
    const rows = await this.sessions.listActive(actor.id);
    return rows.map((s) => ({
      id: s.id,
      device: s.device ?? 'Unknown device',
      browser: s.browser ?? 'Unknown browser',
      os: s.os ?? 'Unknown',
      city: s.city ?? '',
      ip: s.ip ?? '',
      startedAt: s.createdAt.toISOString(),
      lastActiveAt: s.lastActiveAt.toISOString(),
      current: s.id === currentSessionId,
    }));
  }

  /** Log out one other device. Someone else's session looks exactly like one that does not exist. */
  async endSession(actor: Actor, sessionId: string, currentSessionId: string | null, client: RequestInfo): Promise<void> {
    if (sessionId === currentSessionId) throw new BadRequestException({ statusCode: 400, code: 'current_session', message: 'Use log out to end this session' });
    const session = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { employeeId: true, revokedAt: true } });
    if (!session || session.employeeId !== actor.id || session.revokedAt) {
      if (session && session.employeeId !== actor.id) {
        await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'session', targetId: sessionId, outcome: 'denied', reason: 'not_own_session', ...client });
      }
      throw new NotFoundException('Session not found');
    }
    await this.sessions.end(sessionId, 'user');
  }

  async endOtherSessions(actor: Actor, currentSessionId: string | null): Promise<{ ended: number }> {
    return { ended: await this.sessions.endAllFor(actor.id, 'user', currentSessionId ?? undefined) };
  }

  async loginHistory(actor: Actor): Promise<LoginHistoryItem[]> {
    const [sessions, failures] = await Promise.all([
      this.prisma.session.findMany({ where: { employeeId: actor.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
      this.prisma.loginAttempt.findMany({ where: { employeeId: actor.id, success: false }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    const endReason = (r: string | null): LogoutReason | undefined =>
      r === 'user' ? 'clicked' : r === 'idle_timeout' || r === 'max_duration' ? 'timed_out' : r === 'password_changed' ? 'password_changed' : r ? 'forced' : undefined;
    const items: LoginHistoryItem[] = [
      ...sessions.map((s) => ({
        id: s.id,
        at: s.createdAt.toISOString(),
        endedAt: s.revokedAt?.toISOString(),
        success: true,
        twoFactor: s.twoFactorVerifiedAt !== null,
        device: s.device ?? 'Unknown device',
        city: s.city ?? '',
        ip: s.ip ?? '',
        endReason: endReason(s.revokedReason),
      })),
      ...failures.map((f) => ({ id: f.id, at: f.createdAt.toISOString(), success: false, twoFactor: false, device: 'Unknown device', city: '', ip: f.ip })),
    ];
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
