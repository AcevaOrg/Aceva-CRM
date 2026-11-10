import type { Request } from 'express';

/**
 * "Who is making this request?"
 *
 * M1 only needs the answer (an Emp-ID, or nobody). HOW the answer is found belongs to M2:
 * M2 provides a session-cookie implementation and replaces the development one below.
 * Returning null means "not logged in" and the request is rejected with 401.
 */
export abstract class IdentityProvider {
  abstract resolveEmpId(request: Request): Promise<string | null>;
}
