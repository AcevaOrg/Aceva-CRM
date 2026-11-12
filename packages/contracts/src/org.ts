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

/** POST /org/departments (Owner or CEO) */
export const createDepartmentRequestSchema = z.object({
  name: z.string().trim().min(2).max(80),
  /** The department head, chosen explicitly. */
  headEmpId: empIdSchema.optional(),
  reason: reasonSchema,
});
export type CreateDepartmentRequest = z.infer<typeof createDepartmentRequestSchema>;

/** PATCH /org/departments/:code (Owner or CEO). headEmpId null removes the head. */
export const updateDepartmentRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    headEmpId: empIdSchema.nullable().optional(),
    reason: reasonSchema,
  })
  .refine((v) => v.name !== undefined || v.headEmpId !== undefined, { message: 'Nothing to change' });
export type UpdateDepartmentRequest = z.infer<typeof updateDepartmentRequestSchema>;

/** POST /org/offices (Owner or CEO) */
export const createOfficeRequestSchema = z.object({
  name: z.string().trim().min(2).max(80),
  city: z.string().trim().max(80).optional(),
  reason: reasonSchema,
});
export type CreateOfficeRequest = z.infer<typeof createOfficeRequestSchema>;

/** PATCH /org/offices/:code (Owner or CEO) */
export const updateOfficeRequestSchema = z
  .object({ name: z.string().trim().min(2).max(80).optional(), city: z.string().trim().max(80).optional(), reason: reasonSchema })
  .refine((v) => v.name !== undefined || v.city !== undefined, { message: 'Nothing to change' });
export type UpdateOfficeRequest = z.infer<typeof updateOfficeRequestSchema>;

/** POST /org/departments/:code/deactivate and /org/offices/:code/deactivate */
export const deactivateRequestSchema = z.object({ reason: reasonSchema });
export type DeactivateRequest = z.infer<typeof deactivateRequestSchema>;

// ---------- responses ----------

export interface OrgNode {
  empId: string;
  name: string;
  designation: string;
  level: number;
  roleKey: string;
  /** Stable codes (for example dep-eng, off-khi) and display names. */
  departmentId: string;
  officeId: string;
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
  skipped: Array<{ seat: string; reason: 'self' | 'away_no_stand_in' | 'stand_in_is_requester' | 'stand_in_not_authorized' | 'not_active' }>;
}

export interface DepartmentView {
  id: string;
  name: string;
  /** The department head, set explicitly by the Owner or CEO (null when nobody is set). */
  headEmpId: string | null;
  officeIds: string[];
}

export interface OfficeView {
  id: string;
  name: string;
  city: string;
}

export interface DepartmentsResponse {
  departments: DepartmentView[];
  offices: OfficeView[];
  /** departmentId to active headcount */
  headcount: Record<string, number>;
  /** officeId to active headcount */
  officeHeadcount: Record<string, number>;
}

export type OrgChangeKind = 'level' | 'reporting_line' | 'duty' | 'stand_in' | 'department' | 'office';

/** One line of the "recent access changes" feed, built from the audit log. */
export interface OrgChangeView {
  id: string;
  kind: OrgChangeKind;
  summary: string;
  reason: string;
  /** Emp-ID of who did it. */
  by: string | null;
  at: string;
}
