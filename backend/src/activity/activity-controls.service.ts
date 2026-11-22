import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Actor, ScopeTarget } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { ScopeService } from '../access/scope.service';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session/session.service';
import { Clock } from '../common/clock';
import { noteActivity } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityRecorder } from './activity-recorder.service';
import { deviceLabel } from './rules/activity-classify';

/**
 * The controls on the activity screens (plan section 8 "Controls: force logout of a session, lock or unlock an
 * account"). They reuse Module 2: SessionService.end (one session), AuthService.lockAccount and AuthService.unlock.
 *
 * Who: force sign-out and lock require session.force_logout (and auth.unlock_account for a lock), which the Director and
 * the CTO have and the CEO / Founder / Owner does not (he sees everything and acts on nothing), and only for someone
 * BELOW the caller in the reporting line (the CTO: his developers; the Director: everyone below him), never yourself.
 * Unlock is Module 2's unlock, unchanged. Every control needs a confirm-again (password and authenticator code) in the
 * last 5 minutes, is audited, and the action recorder adds it to the caller's activity.
 */
@Injectable()
export class ActivityControlsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly recorder: ActivityRecorder,
    private readonly clock: Clock,
  ) {}

  /** POST /sessions/:id/force-logout: ends one session of someone below the caller. */
  async forceLogout(actor: Actor, actorSessionId: string | null, sessionId: string, reason: string, client: RequestInfo): Promise<{ ok: true }> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, revokedAt: true, employeeId: true, device: true, browser: true, os: true, employee: { select: { empId: true } } },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.employeeId === actor.id || !(await this.scope.canAccess(actor.id, session.employeeId, 'below'))) {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'session', targetId: session.id, outcome: 'denied', reason: 'out_of_scope', details: { attempted: 'session.force_logout', empId: session.employee.empId }, ...client });
      throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'You can only sign out people below you in your reporting line' });
    }
    await this.requireStepUp(actor, actorSessionId, 'session.force_logout', session.employee.empId, client);
    if (session.revokedAt || !(await this.sessions.end(session.id, 'forced'))) {
      throw new ConflictException({ statusCode: 409, code: 'session_ended', message: 'This session has already ended' });
    }
    const device = deviceLabel(session);
    await this.audit.record({ actorId: actor.id, action: 'auth.session.forced_logout', targetType: 'employee', targetId: session.employee.empId, reason, details: { sessionId: session.id, ended: 1 }, ...client });
    noteActivity({ target: session.employee.empId, description: `Signed ${session.employee.empId} out (${device})` });
    // The employee sees why in their own activity ("My activity"); Module 2's logout event adds "signed out by an administrator".
    this.recorder.record({
      employeeId: session.employeeId,
      empId: session.employee.empId,
      occurredAt: this.clock.now(),
      action: 'security',
      module: 'Login',
      target: actor.empId,
      description: `Signed out by ${actor.empId} (${actor.fullName}): ${reason}`,
      sessionId: null,
      requestId: null,
      device,
      city: null,
      details: { kind: 'forced_logout', by: actor.empId },
    });
    return { ok: true };
  }

  /** POST /employees/:empId/lock: locks the account of someone below the caller and ends every session. */
  async lock(actor: Actor, actorSessionId: string | null, target: ScopeTarget, reason: string, client: RequestInfo): Promise<{ ok: true; ended: number }> {
    await this.requireStepUp(actor, actorSessionId, 'auth.lock_account', target.empId, client);
    const { ended } = await this.auth.lockAccount(actor, target, reason, client);
    return { ok: true, ended };
  }

  /**
   * POST /employees/:empId/unlock: exactly Module 2's unlock (AuthService.unlock decides who: someone above the person
   * in the reporting line, HR duty, or the CEO / Founder / Owner for his direct report, the Director, only), after a
   * confirm-again. The activity screens offer the button to the Director and the CTO only; the Owner's one unlock right
   * is used from the Director's profile.
   */
  async unlock(actor: Actor, actorSessionId: string | null, targetEmpId: string, reason: string | undefined, client: RequestInfo): Promise<{ ok: true }> {
    await this.requireStepUp(actor, actorSessionId, 'auth.unlock_account', targetEmpId, client);
    await this.auth.unlock(actor, targetEmpId, reason, client);
    return { ok: true };
  }

  /** The controls are risky: a confirm-again (password, and the authenticator code where used) within 5 minutes. */
  private async requireStepUp(actor: Actor, sessionId: string | null, attempted: string, targetEmpId: string, client: RequestInfo): Promise<void> {
    if (await this.sessions.hasRecentStepUp(sessionId)) return;
    await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'employee', targetId: targetEmpId, outcome: 'denied', reason: 'step_up_required', details: { attempted }, ...client });
    throw new ForbiddenException({ statusCode: 403, code: 'step_up_required', message: 'Confirm your password again to do this' });
  }
}
