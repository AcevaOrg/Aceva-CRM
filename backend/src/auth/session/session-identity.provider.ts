import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { IdentityProvider, type ResolvedIdentity } from '../../identity/identity.provider';
import { AuthStateService } from '../auth-state.service';
import { SESSION_COOKIE } from './session-cookie';
import { SessionService } from './session.service';

/**
 * The real "who is calling": reads the HttpOnly session cookie and verifies the session on EVERY request
 * (not expired, not ended, within the idle and maximum limits), then works out how far the login has got.
 */
@Injectable()
export class SessionIdentityProvider extends IdentityProvider {
  constructor(
    private readonly sessions: SessionService,
    private readonly state: AuthStateService,
  ) {
    super();
  }

  async resolve(request: Request, options: { financeScreen: boolean }): Promise<ResolvedIdentity | null> {
    const token = (request.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!token || typeof token !== 'string') return null;

    const check = await this.sessions.authenticate(token, options);
    if (!check.ok) return null;
    const { session } = check;

    const state = await this.state.get(session.employeeId);
    if (!state || !state.canLogIn) {
      await this.sessions.end(session.id, 'employee_left');
      return null;
    }
    return {
      empId: session.empId,
      stage: this.state.stage(state, session.twoFactorVerified),
      sessionId: session.id,
      csrfHash: session.csrfHash,
    };
  }
}
