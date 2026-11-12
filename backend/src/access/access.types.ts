/** The logged-in employee, attached to the request by AccessGuard. */
export interface Actor {
  /** Internal UUID (never sent to the browser). */
  id: string;
  /** What people see, for example ACV-0003. */
  empId: string;
  fullName: string;
  levelNumber: number;
  roleKey: string;
}

/** The employee a request is about (set when a route uses @Scope). */
export interface ScopeTarget {
  id: string;
  empId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
    scopeTarget?: ScopeTarget;
    /** The id of the session behind this request (null/undefined only for requests without a session). */
    sessionId?: string | null;
  }
}
