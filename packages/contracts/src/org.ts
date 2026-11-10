import { z } from 'zod';
import { empIdSchema } from './events';

/** A reason is mandatory for every change to levels, roles, duties or reporting lines (plan section 5). */
export const reasonSchema = z.string().trim().min(5, 'Please give a reason (at least 5 characters)').max(500);

const isoDate = z.iso.date();

// ---------- requests ----------

/** PATCH /org/employees/:empId/level  (Owner or CEO only) */
export const changeLevelRequestSchema = z.object({
  level: z.number().int().min(2).max(5),
  /** Optional: a named role at that level (for example "director"). Default: the level's default role. */
  roleKey: z.string().min(1).optional(),
  reason: reasonSchema,
});
export type ChangeLevelRequest = z.infer<typeof changeLevelRequestSchema>;

/** PATCH /org/employees/:empId/reporting-line  (Owner or CEO only) */
export const changeReportingLineRequestSchema = z.object({
  reportsToEmpId: empIdSchema,
  reason: reasonSchema,
});
export type ChangeReportingLineRequest = z.infer<typeof changeReportingLineRequestSchema>;

/** POST /org/employees/:empId/duties  (Director) */
export const assignDutyRequestSchema = z.object({
  dutyKey: z.string().min(1),
  reason: reasonSchema,
});
export type AssignDutyRequest = z.infer<typeof assignDutyRequestSchema>;

/** DELETE /org/employees/:empId/duties/:dutyKey  (Director) */
export const endDutyRequestSchema = z.object({ reason: reasonSchema });
export type EndDutyRequest = z.infer<typeof endDutyRequestSchema>;

/**
 * POST /stand-ins
 * A manager is away for a period. With a stand-in, approvals go to the stand-in;
 * without one, approvals go one level up.
 */
export const createStandInRequestSchema = z
  .object({
    standInEmpId: empIdSchema.optional(),
    startsOn: isoDate,
    endsOn: isoDate,
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.endsOn >= v.startsOn, { path: ['endsOn'], message: 'End date must not be before the start date' });
export type CreateStandInRequest = z.infer<typeof createStandInRequestSchema>;

/** DELETE /stand-ins/:id */
export const revokeStandInRequestSchema = z.object({ reason: reasonSchema });
export type RevokeStandInRequest = z.infer<typeof revokeStandInRequestSchema>;

/** GET /approvals/route/:empId?date=YYYY-MM-DD&afterSeat=ACV-0004 */
export const approvalRouteQuerySchema = z.object({
  date: isoDate.optional(),
  /** Continue one step further up, after the person who held the previous step. */
  afterSeat: empIdSchema.optional(),
});
export type ApprovalRouteQuery = z.infer<typeof approvalRouteQuerySchema>;

// ---------- responses ----------

export interface OrgNode {
  empId: string;
  name: string;
  designation: string;
  level: number;
  roleKey: string;
  department: string;
  office: string;
  status: 'active' | 'on_notice' | 'left';
  reportsTo: string | null;
  duties: string[];
  children: OrgNode[];
}

export interface TeamMember {
  empId: string;
  name: string;
  designation: string;
  level: number;
  department: string;
  reportsTo: string | null;
  /** 0 = the person themselves, 1 = direct report, 2 = report of a report ... */
  depth: number;
}

export interface AccessMe {
  empId: string;
  name: string;
  level: number;
  roleKey: string;
  duties: string[];
  permissions: string[];
  twoFactorRequired: boolean;
}

export interface StandInView {
  id: string;
  manager: string;
  standIn: string | null;
  startsOn: string;
  endsOn: string;
  reason: string | null;
  revokedAt: string | null;
}

export type ApprovalRouteVia = 'manager' | 'stand_in';

export interface ApprovalRouteStep {
  /** The person who should approve. Null when nobody above can (the top of the chain). */
  approver: string | null;
  /** The position in the reporting chain this step belongs to (pass it as afterSeat for the next step up). */
  seat: string | null;
  via: ApprovalRouteVia | null;
  /** Positions that were passed over, and why. */
  skipped: Array<{ seat: string; reason: 'self' | 'away_no_stand_in' | 'stand_in_is_requester' | 'stand_in_not_authorized' }>;
}
