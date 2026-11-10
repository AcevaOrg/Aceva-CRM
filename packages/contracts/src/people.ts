import { z } from 'zod';
import { empIdSchema } from './events';

// ---------------------------------------------------------------------------
// Employee profiles (plan section 7)
// ---------------------------------------------------------------------------

const optionalText = (max: number) => z.string().trim().max(max);
const isoDate = z.iso.date();

export const employmentTypeSchema = z.enum(['full_time', 'part_time', 'intern']);
export const employeeStatusSchema = z.enum(['active', 'on_notice', 'left']);
export const documentTypeSchema = z.enum(['cv', 'contract', 'cnic_copy', 'certificate']);

/** CNIC: 13 digits, with or without dashes. Stored as 12345-1234567-1. */
export const cnicSchema = z
  .string()
  .trim()
  .regex(/^\d{5}-?\d{7}-?\d$/, 'A CNIC has 13 digits, for example 42101-1234567-1')
  .transform((v) => {
    const d = v.replace(/-/g, '');
    return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
  });

const phoneSchema = z.string().trim().regex(/^\+?[\d\s-]{7,20}$/, 'Enter a phone number, for example +92 300 1234567');
const bankAccountSchema = z.string().trim().regex(/^[A-Za-z0-9-]{6,34}$/, 'Enter the bank account number or IBAN (letters, digits, dashes)');
const officialEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .refine((v) => v.endsWith('@acevatech.com'), 'The official email must end with @acevatech.com');
const money = z
  .number()
  .min(0)
  .max(9_999_999_999)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Use at most 2 decimal places');

export const emergencyContactSchema = z.object({
  name: optionalText(120).min(1, 'Enter a name'),
  relation: optionalText(60).min(1, 'Enter the relation'),
  phone: phoneSchema,
});

// ---------- requests ----------

/** PATCH /employees/:empId/basic: Director or HR (job-related) */
export const updateBasicRequestSchema = z
  .object({
    name: optionalText(120).min(2).optional(),
    designation: optionalText(120).min(2).optional(),
    departmentId: z.string().min(1).optional(),
    officeId: z.string().min(1).optional(),
    officialEmail: officialEmailSchema.optional(),
    reason: optionalText(500).optional(),
  })
  .strict();
export type UpdateBasicRequest = z.infer<typeof updateBasicRequestSchema>;

/**
 * PATCH /employees/:empId/job: joining date, type, status and weekly capacity by the Director or HR.
 * `level` and `reportsToEmpId` are accepted here for convenience but are changed ONLY by the Owner or CEO (Module 1 rules).
 */
export const updateJobRequestSchema = z
  .object({
    joiningDate: isoDate.optional(),
    type: employmentTypeSchema.optional(),
    /** "left" is set only by the leaving workflow. */
    status: z.enum(['active', 'on_notice']).optional(),
    weeklyCapacityHours: z.number().int().min(0).max(168).optional(),
    level: z.number().int().min(2).max(5).optional(),
    reportsToEmpId: empIdSchema.optional(),
    reason: optionalText(500).min(5, 'Please give a reason (at least 5 characters)'),
  })
  .strict();
export type UpdateJobRequest = z.infer<typeof updateJobRequestSchema>;

/** PATCH /employees/:empId/personal: the employee (phone, address, emergency contact) or Director/HR (everything) */
export const updatePersonalRequestSchema = z
  .object({
    cnic: cnicSchema.optional(),
    phone: phoneSchema.optional(),
    homeAddress: optionalText(300).min(3).optional(),
    emergencyContact: emergencyContactSchema.optional(),
  })
  .strict();
export type UpdatePersonalRequest = z.infer<typeof updatePersonalRequestSchema>;

/** PATCH /employees/:empId/pay: the Director only */
export const updatePayRequestSchema = z
  .object({
    baseSalary: money.optional(),
    /** All allowances together, per month. */
    allowances: money.optional(),
    bankName: optionalText(80).min(2).optional(),
    accountNumber: bankAccountSchema.optional(),
    reason: optionalText(500).min(5, 'Please give a reason (at least 5 characters)'),
  })
  .strict();
export type UpdatePayRequest = z.infer<typeof updatePayRequestSchema>;

/** POST /employees: the joining workflow (Director or HR) */
export const createEmployeeRequestSchema = z
  .object({
    name: optionalText(120).min(2),
    designation: optionalText(120).min(2),
    departmentId: z.string().min(1),
    officeId: z.string().min(1),
    officialEmail: officialEmailSchema,
    level: z.number().int().min(3).max(5),
    reportsToEmpId: empIdSchema,
    joiningDate: isoDate,
    type: employmentTypeSchema,
    weeklyCapacityHours: z.number().int().min(0).max(168).optional(),
    personal: z
      .object({ cnic: cnicSchema.optional(), phone: phoneSchema.optional(), homeAddress: optionalText(300).optional(), emergencyContact: emergencyContactSchema.optional() })
      .optional(),
    /** Only the Director may set pay. */
    pay: z.object({ baseSalary: money, allowances: money.optional(), bankName: optionalText(80).optional(), accountNumber: bankAccountSchema.optional() }).optional(),
  })
  .strict();
export type CreateEmployeeRequest = z.infer<typeof createEmployeeRequestSchema>;

/** POST /employees/:empId/offboard: HR (or the Director) sets the last working day */
export const offboardRequestSchema = z.object({
  lastWorkingDay: isoDate,
  reason: optionalText(500).min(5, 'Please give a reason (at least 5 characters)'),
});
export type OffboardRequest = z.infer<typeof offboardRequestSchema>;

/** POST /employees/:empId/reveal: show a masked value (logged every time) */
export const revealRequestSchema = z.object({ field: z.enum(['cnic', 'account']) });
export type RevealRequest = z.infer<typeof revealRequestSchema>;

/** GET /employees?q= */
export const directoryQuerySchema = z.object({ q: z.string().trim().max(80).optional() });
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>;

// ---------- responses ----------

export interface DirectoryEntry {
  empId: string;
  name: string;
  designation: string;
  departmentId: string;
  officeId: string;
  officialEmail: string | null;
  hasPhoto: boolean;
}

export interface EmployeeJobView {
  level: number;
  roleKey: string;
  reportsTo: string | null;
  joiningDate: string;
  type: 'full_time' | 'part_time' | 'intern';
  status: 'active' | 'on_notice' | 'left';
  lastWorkingDay: string | null;
  weeklyCapacityHours: number;
}

export interface PersonalView {
  /** Masked: ********1234. The full number is only shown through POST /employees/:empId/reveal. */
  cnicMasked: string | null;
  phone: string | null;
  homeAddress: string | null;
  emergencyContact: { name: string; relation: string; phone: string } | null;
}

export interface PayView {
  baseSalary: string;
  allowances: string;
  currency: 'PKR';
  bankName: string | null;
  accountMasked: string | null;
}

export interface DocumentView {
  id: string;
  kind: 'cv' | 'contract' | 'cnic_copy' | 'certificate';
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string | null;
}

export type ProfileSectionName = 'basic' | 'job' | 'personal' | 'pay' | 'documents' | 'history';

export interface FieldChangeView {
  id: string;
  section: 'basic' | 'job' | 'personal' | 'pay';
  field: string;
  oldValue: string;
  newValue: string;
  changedBy: string | null;
  changedAt: string;
  reason?: string;
}

/** What the person asking may see and change on this profile, worked out by the server. */
export interface ProfileAccessView {
  isSelf: boolean;
  see: Record<ProfileSectionName, boolean>;
  edit: { basic: boolean; job: boolean; personal: 'none' | 'contact' | 'all'; pay: boolean; documents: boolean };
  revealCnic: boolean;
  revealPay: boolean;
}

export interface ProfileResponse {
  basic: DirectoryEntry;
  job?: EmployeeJobView;
  personal?: PersonalView;
  pay?: PayView;
  documents?: DocumentView[];
  history?: FieldChangeView[];
  access: ProfileAccessView;
}

export interface CreateEmployeeResponse {
  empId: string;
  /** false when the welcome email could not be sent (use "resend welcome"). */
  welcomeEmailSent: boolean;
  /** True when no pay was entered (the Director sets it). */
  payPending: boolean;
}

export interface OffboardResponse {
  empId: string;
  lastWorkingDay: string;
  /** "now" when the date is today or in the past; "scheduled" otherwise. */
  processed: 'now' | 'scheduled';
  /** People who reported to this person and now need a new manager (Owner or CEO moves them). */
  directReportsNeedingManager: string[];
}
