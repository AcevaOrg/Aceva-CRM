import type { Request } from 'express';

/**
 * How far a login has got. Only 'ok' may use the application; the others may only finish logging in.
 *  password_change_required  the password is temporary and must be changed first
 *  2fa_required              the 6-digit authenticator code is still to be entered
 *  2fa_setup_required        2FA is mandatory (or switched on) but the authenticator app is not set up yet
 */
export type SessionStage = 'ok' | 'password_change_required' | '2fa_required' | '2fa_setup_required';

export interface ResolvedIdentity {
  empId: string;
  stage: SessionStage;
  sessionId: string | null;
  /** SHA-256 of the CSRF token this session expects on change requests. */
  csrfHash: string;
}

/**
 * "Who is making this request?"  Returning null means "not logged in" and the request gets 401.
 * The real implementation reads the session cookie (SessionIdentityProvider).
 */
export abstract class IdentityProvider {
  abstract resolve(request: Request, options: { financeScreen: boolean }): Promise<ResolvedIdentity | null>;
}
