import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { IdentityProvider } from './identity.provider';

/**
 * TEMPORARY, DEVELOPMENT/TEST ONLY. Reads the Emp-ID from the "X-Dev-Emp-Id" header.
 *
 * This is NOT authentication: anybody can send the header. It exists so M1 (permissions and
 * hierarchy) can be built and tested before M2 (real Emp-ID login and sessions). It is
 * switched off unless DEV_IDENTITY_ENABLED=true, the app refuses to start with it in
 * production, and M2 replaces it with a session-cookie provider.
 */
@Injectable()
export class DevHeaderIdentityProvider extends IdentityProvider {
  constructor(@Inject(ENV) private readonly env: Env) {
    super();
  }

  async resolveEmpId(request: Request): Promise<string | null> {
    if (!this.env.DEV_IDENTITY_ENABLED || this.env.NODE_ENV === 'production') {
      return null; // fail closed: nobody is logged in
    }
    const header = request.header('x-dev-emp-id');
    return header && /^ACV-\d{4,}$/.test(header) ? header : null;
  }
}
