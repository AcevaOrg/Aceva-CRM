import { z } from 'zod';
import { empIdSchema } from './events';
import { decisionReasonSchema, pageQuerySchema } from './shared';

/**
 * Module 15: sales and CRM (plan section 20). M15.1: leads and companies.
 *
 * Rules from the plan this part follows:
 *  - one record per person (lead) and one per company; each lead has exactly one owner (a salesperson's Emp-ID);
 *  - "One owner, no duplicates": before a lead is saved the email and the company's website domain are checked; when the
 *    lead already exists the owner is shown instead of a second copy being made;
 *  - only the listed fields are kept, and where each lead came from is always recorded;
 *  - a salesperson sees their own leads; others' leads only as "it exists, and who owns it" (never notes, phone or email);
 *  - the sales manager (the Director until there is one) sees and manages the whole sales team.
 * The email check result (MillionVerifier) belongs to Module 16; Module 15 only stores it ("unchecked").
 */

// ------------------------------------------------------------------------------------------------- normalising (pure)

/** The email used for the duplicate check: trimmed and lower-case. Nothing else is changed (no guessing about dots or "+"). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The company domain of a website: "https://www.Acme.com/about" -> "acme.com". Null when the text is not a web address
 * with a real domain (an IP address or a single word identifies no company). Sub-domains stay as they are
 * ("shop.acme.com" is not "acme.com"): there is no rule for merging them.
 */
export function websiteDomain(website: string): string | null {
  const raw = website.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host || !host.includes('.') || host.length > 253) return null;
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  return host;
}

// ------------------------------------------------------------------------------------------------------------ values

export const SALES_LEAD_SOURCES = ['apollo', 'fiverr', 'linkedin', 'referral', 'website', 'field', 'walk_in'] as const;
export const salesLeadSourceSchema = z.enum(SALES_LEAD_SOURCES);
export type SalesLeadSource = z.infer<typeof salesLeadSourceSchema>;

export const SALES_EMAIL_CHECKS = ['unchecked', 'valid', 'invalid', 'catch_all', 'unknown'] as const;
export const salesEmailCheckSchema = z.enum(SALES_EMAIL_CHECKS);
export type SalesEmailCheck = z.infer<typeof salesEmailCheckSchema>;

/** Duplicate checks a person may run per minute (each answer says who owns an email, so it is limited and logged). */
export const SALES_DUPLICATE_CHECKS_PER_MINUTE = 30;

const text = (max: number) => z.string().trim().min(1, 'Required').max(max);
/** Optional on create; on edit, null clears the field. An empty text means "nothing" too. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

const webAddress = (what: string) =>
  z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === '' || websiteDomain(v) !== null, `Enter the ${what} as a web address, for example acme.com`);

const websiteSchema = webAddress('website')
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v));

const linkedinSchema = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || /^https?:\/\//i.test(v) || websiteDomain(v) !== null, 'Enter the LinkedIn link as a web address')
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v));

const emailSchema = z
  .string()
  .trim()
  .max(254)
  .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address')
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v));

const versionSchema = z.number().int().min(1);

// ----------------------------------------------------------------------------------------------------------- requests

export const salesCompanyInputSchema = z.object({
  name: text(200),
  website: websiteSchema,
  country: optionalText(80),
  industry: optionalText(100),
});
export type SalesCompanyInput = z.output<typeof salesCompanyInputSchema>;

/** POST /sales/companies */
export const createSalesCompanySchema = salesCompanyInputSchema;
export type CreateSalesCompanyRequest = z.input<typeof createSalesCompanySchema>;
export type CreateSalesCompanyData = z.output<typeof createSalesCompanySchema>;

/** PATCH /sales/companies/:id (name the version you read). */
export const updateSalesCompanySchema = z
  .object({
    name: text(200).optional(),
    website: websiteSchema,
    country: optionalText(80),
    industry: optionalText(100),
    version: versionSchema,
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'version' && v[k as keyof typeof v] !== undefined), 'Change at least one field');
export type UpdateSalesCompanyRequest = z.input<typeof updateSalesCompanySchema>;
export type UpdateSalesCompanyData = z.output<typeof updateSalesCompanySchema>;

const leadFields = {
  fullName: text(200),
  jobTitle: optionalText(150),
  email: emailSchema,
  phone: optionalText(40),
  linkedinUrl: linkedinSchema,
  country: optionalText(80),
  industry: optionalText(100),
  notes: optionalText(5000),
};

/**
 * POST /sales/leads. The company is an existing one (companyId) or a new one (company); a new company whose website
 * domain already belongs to a company is that company (never a second copy). ownerEmpId: only the sales manager may
 * give the new lead to someone else; everyone else owns what they add.
 */
export const createSalesLeadSchema = z
  .object({
    ...leadFields,
    source: salesLeadSourceSchema,
    companyId: z.uuid().optional(),
    company: salesCompanyInputSchema.optional(),
    ownerEmpId: empIdSchema.optional(),
  })
  .refine((v) => !(v.companyId && v.company), { message: 'Choose an existing company or describe a new one, not both', path: ['company'] });
export type CreateSalesLeadRequest = z.input<typeof createSalesLeadSchema>;
/** The request after validation (what the server works with). */
export type CreateSalesLeadData = z.output<typeof createSalesLeadSchema>;

/** PATCH /sales/leads/:id (name the version you read). The owner changes only through POST /sales/leads/:id/owner. */
export const updateSalesLeadSchema = z
  .object({
    fullName: text(200).optional(),
    jobTitle: leadFields.jobTitle,
    email: leadFields.email,
    phone: leadFields.phone,
    linkedinUrl: leadFields.linkedinUrl,
    country: leadFields.country,
    industry: leadFields.industry,
    notes: leadFields.notes,
    source: salesLeadSourceSchema.optional(),
    /** null removes the company from the lead. */
    companyId: z.uuid().nullable().optional(),
    company: salesCompanyInputSchema.optional(),
    version: versionSchema,
  })
  .refine((v) => !(v.companyId && v.company), { message: 'Choose an existing company or describe a new one, not both', path: ['company'] })
  .refine((v) => Object.keys(v).some((k) => k !== 'version' && v[k as keyof typeof v] !== undefined), 'Change at least one field');
export type UpdateSalesLeadRequest = z.input<typeof updateSalesLeadSchema>;
export type UpdateSalesLeadData = z.output<typeof updateSalesLeadSchema>;

/** POST /sales/leads/:id/owner: the sales manager moves a lead to another salesperson (logged with the reason). */
export const reassignSalesLeadSchema = z.object({ toEmpId: empIdSchema, reason: decisionReasonSchema, version: versionSchema });
export type ReassignSalesLeadRequest = z.infer<typeof reassignSalesLeadSchema>;

/** POST /sales/leads/check-duplicate: the check made before a lead is saved (the screen calls it while typing). */
export const salesDuplicateCheckSchema = z
  .object({
    email: z.string().trim().max(254).optional(),
    website: z.string().trim().max(300).optional(),
  })
  .refine((v) => !!v.email || !!v.website, 'Give an email or a website to check');
export type SalesDuplicateCheckRequest = z.infer<typeof salesDuplicateCheckSchema>;

/** GET /sales/leads */
export const salesLeadListQuerySchema = pageQuerySchema.extend({
  owner: empIdSchema.optional(),
  source: salesLeadSourceSchema.optional(),
  country: z.string().trim().max(80).optional(),
  companyId: z.uuid().optional(),
  /** Name, email, job title or company name contains this. */
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
});
export type SalesLeadListQuery = z.infer<typeof salesLeadListQuerySchema>;

/** GET /sales/companies */
export const salesCompanyListQuerySchema = pageQuerySchema.extend({ q: z.string().trim().max(100).optional() });
export type SalesCompanyListQuery = z.infer<typeof salesCompanyListQuerySchema>;

// ----------------------------------------------------------------------------------------------------------- settings

/** The module_settings key of Module 15. */
export const SALES_SETTINGS = 'sales';

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?!www\.)([a-z0-9-]+\.)+[a-z0-9-]+$/, 'A domain looks like fiverr.com');

/**
 * Module 15's settings (Settings > Sales). Changing them needs settings.manage (the Director) and is logged.
 * sharedWebsiteDomains: domains that never identify one company, for example a marketplace or social network where many
 * companies have a profile page. A website on one of them is kept, but it is not used for the company duplicate check.
 * The list starts EMPTY: which domains belong on it is a CTO / management decision (it is not invented here).
 */
export const salesSettingsSchema = z.object({
  sharedWebsiteDomains: z
    .array(domainSchema)
    .max(200)
    .refine((v) => new Set(v).size === v.length, 'Each domain only once'),
});
export type SalesSettings = z.infer<typeof salesSettingsSchema>;
export const SALES_SETTINGS_DEFAULTS: SalesSettings = { sharedWebsiteDomains: [] };

// -------------------------------------------------------------------------------------------------------------- views

export interface SalesPersonRef {
  empId: string;
  name: string;
}

export interface SalesCompanyView {
  id: string;
  name: string;
  website: string | null;
  /** The normalised domain used for the duplicate check (null: no website, or a shared domain). */
  domain: string | null;
  country: string | null;
  industry: string | null;
  /** The Module 9 client, once the company is one. */
  partyId: string | null;
  archived: boolean;
  version: number;
  createdAt: string;
  canEdit: boolean;
}

export interface SalesCompanyDetailView extends SalesCompanyView {
  /** The company's leads the caller may see in full. */
  leads: SalesLeadView[];
  /** How many other people's leads the company has (their details stay hidden). */
  otherLeads: number;
}

/** A lead the caller may see in full: their own, or one in their team (sales manager), or any (sales.all). */
export interface SalesLeadView {
  restricted: false;
  id: string;
  fullName: string;
  jobTitle: string | null;
  company: SalesCompanyView | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  country: string | null;
  industry: string | null;
  source: SalesLeadSource;
  owner: SalesPersonRef;
  emailCheck: SalesEmailCheck;
  emailCheckedAt: string | null;
  notes: string | null;
  lastActivityAt: string;
  archived: boolean;
  version: number;
  createdAt: string;
  createdBy: SalesPersonRef | null;
  updatedAt: string;
  canEdit: boolean;
  canReassign: boolean;
}

/** Someone else's lead: only that it exists and who owns it (plan section 20). */
export interface SalesLeadStubView {
  restricted: true;
  id: string;
  fullName: string;
  companyName: string | null;
  owner: SalesPersonRef;
}

export type SalesLeadResult = SalesLeadView | SalesLeadStubView;

export interface SalesDuplicateCheckView {
  /** A lead that is not archived already has this email. */
  email: { leadId: string; owner: SalesPersonRef; mine: boolean; canOpen: boolean } | null;
  /** The domain checked (null when there was no website, or it is not a web address). */
  domain: string | null;
  /** The website is on a shared domain (settings): it says nothing about the company. */
  sharedDomain: boolean;
  /** A company that is not archived already has this domain, and who owns leads there. */
  company: { companyId: string; name: string; leadOwners: SalesPersonRef[] } | null;
}

/** 409 duplicate_lead: the lead exists; who owns it. */
export interface SalesDuplicateLeadError {
  statusCode: 409;
  code: 'duplicate_lead';
  message: string;
  existing: { leadId: string; owner: SalesPersonRef };
}
