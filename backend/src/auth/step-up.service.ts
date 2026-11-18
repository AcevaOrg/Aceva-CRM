import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { SessionService } from './session/session.service';

/**
 * "Confirm again" for risky actions (plan section 16): approving payroll, posting large entries, reopening a closed
 * month, exporting statements, viewing bank details. The person confirms with POST /auth/step-up (password, and the
 * authenticator code where they use one); this service checks, on the server, that THIS session did so within the last
 * 5 minutes. A refusal is audited and answered with 403 `step_up_required`.
 */
@Injectable()
export class StepUpService {
  constructor(
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async require(
    actor: Actor,
    sessionId: string | null,
    action: string,
    target: { type: string; id?: string | null },
    client: RequestInfo,
  ): Promise<void> {
    if (await this.sessions.hasRecentStepUp(sessionId)) return;
    await this.audit.record({
      actorId: actor.id,
      action: 'access.denied',
      targetType: target.type,
      targetId: target.id ?? null,
      outcome: 'denied',
      reason: 'step_up_required',
      details: { attempted: action },
      ...client,
    });
    throw new ForbiddenException({ statusCode: 403, code: 'step_up_required', message: 'Confirm your password again to do this' });
  }
}
