import { z } from 'zod';
import { empIdSchema } from './events';
import { currencySchema, daySchema, decisionReasonSchema, moneySchema, pageQuerySchema, type Currency } from './shared';

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
  /**
   * M15.2: the reasons a deal can be marked Lost (plan section 20 gives examples only: price, no reply, chose another
   * company). Empty until management sets the list; until then no deal can be marked Lost.
   */
  lostReasons: z
    .array(z.string().trim().min(2).max(80))
    .max(30)
    .refine((v) => new Set(v.map((r) => r.toLowerCase())).size === v.length, 'Each reason only once')
    .default([]),
  /**
   * M15.2: months after a Lost deal before the lead may be contacted again (plan section 20: "a set number of months").
   * Null until management sets it; until then no deal can be marked Lost.
   */
  recontactMonths: z.number().int().min(1).max(60).nullable().default(null),
  /**
   * M15.5: a lead with no activity for this many months is archived and its contact details removed (plan section 20:
   * "Leads with no activity for 12 months are archived ... The period is a setting"; approved default 12).
   */
  archiveMonths: z.number().int().min(1).max(120).default(12),
});
export type SalesSettings = z.infer<typeof salesSettingsSchema>;
export const SALES_SETTINGS_DEFAULTS: SalesSettings = { sharedWebsiteDomains: [], lostReasons: [], recontactMonths: null, archiveMonths: 12 };

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
  /** M15.4: a do-not-contact request is saved on the lead (it never goes away; outgoing contact is refused). */
  doNotContact: boolean;
  /** M15.5: why and when the lead was archived (null while it is not archived). */
  archive: SalesLeadArchiveView | null;
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

// =============================================================================================================== M15.2
// Deals and the pipeline (plan section 20): a deal is one sales opportunity with a company; it sits in one of eight
// stages; Lost needs a reason (and the lead may be contacted again after a set number of months); Won is marked by the
// salesperson and confirmed by the sales manager (the Director until there is one), never by the person who owns or
// asked for it. A confirmed Won deal is handed to Module 13 through sales.deal.won_confirmed (one draft invoice).

export const SALES_DEAL_STAGES = ['new', 'contacted', 'replied', 'meeting_booked', 'proposal_sent', 'negotiation', 'won', 'lost'] as const;
export const salesDealStageSchema = z.enum(SALES_DEAL_STAGES);
export type SalesDealStage = z.infer<typeof salesDealStageSchema>;
/** The stages a deal is still being worked in (every open deal has a next step with a date). */
export const SALES_OPEN_STAGES = ['new', 'contacted', 'replied', 'meeting_booked', 'proposal_sent', 'negotiation'] as const satisfies readonly SalesDealStage[];
export const isOpenDealStage = (s: SalesDealStage): boolean => (SALES_OPEN_STAGES as readonly SalesDealStage[]).includes(s);

/** The services Aceva sells (plan section 20). */
export const SALES_DEAL_SERVICES = ['website', 'custom_software', 'ai_automation', 'mobile_app', 'ecommerce'] as const;
export const salesDealServiceSchema = z.enum(SALES_DEAL_SERVICES);
export type SalesDealService = z.infer<typeof salesDealServiceSchema>;
/** How a service is named on the deal and on the draft invoice line Module 13 makes from a Won deal. */
export const SALES_DEAL_SERVICE_LABEL: Record<SalesDealService, string> = {
  website: 'Website',
  custom_software: 'Custom software',
  ai_automation: 'AI automation',
  mobile_app: 'Mobile app',
  ecommerce: 'E-commerce store',
};

export const SALES_WON_STATUSES = ['none', 'pending', 'confirmed'] as const;
export type SalesWonStatus = (typeof SALES_WON_STATUSES)[number];

/** What a history row records. Stage rows have from and to; Won request rows keep the stage the deal is in. */
export const SALES_DEAL_EVENTS = ['created', 'stage_changed', 'won_requested', 'won_rejected', 'won_confirmed', 'owner_changed'] as const;
export type SalesDealEvent = (typeof SALES_DEAL_EVENTS)[number];

const nextStepText = z.string().trim().min(2, 'Describe the next step').max(300);

/** POST /sales/deals: a deal for one of your leads (or a team member's, for the sales manager); it starts in New. */
export const createSalesDealSchema = z.object({
  leadId: z.uuid(),
  service: salesDealServiceSchema,
  value: moneySchema,
  currency: currencySchema,
  expectedClose: daySchema,
  nextStep: nextStepText,
  nextStepDate: daySchema,
});
export type CreateSalesDealRequest = z.input<typeof createSalesDealSchema>;
export type CreateSalesDealData = z.output<typeof createSalesDealSchema>;

/** PATCH /sales/deals/:id (an open deal that is not waiting for Won confirmation; name the version you read). */
export const updateSalesDealSchema = z
  .object({
    service: salesDealServiceSchema.optional(),
    value: moneySchema.optional(),
    currency: currencySchema.optional(),
    expectedClose: daySchema.optional(),
    nextStep: nextStepText.optional(),
    nextStepDate: daySchema.optional(),
    version: versionSchema,
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'version' && v[k as keyof typeof v] !== undefined), 'Change at least one field');
export type UpdateSalesDealRequest = z.input<typeof updateSalesDealSchema>;
export type UpdateSalesDealData = z.output<typeof updateSalesDealSchema>;

/**
 * POST /sales/deals/:id/move. To an open stage (the deal keeps or gets a next step); to Lost (lostReason from the
 * settings list, an optional note; the re-contact date follows from the settings). Won is never a move: it is asked
 * for (request-won) and confirmed by the sales manager.
 */
export const moveSalesDealSchema = z
  .object({
    toStage: salesDealStageSchema,
    version: versionSchema,
    nextStep: nextStepText.optional(),
    nextStepDate: daySchema.optional(),
    lostReason: z.string().trim().min(2).max(80).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.toStage !== 'won', { message: 'Won is asked for with request-won and confirmed by the sales manager', path: ['toStage'] })
  .refine((v) => v.toStage !== 'lost' || !!v.lostReason, { message: 'Choose why the deal was lost', path: ['lostReason'] });
export type MoveSalesDealRequest = z.input<typeof moveSalesDealSchema>;
export type MoveSalesDealData = z.output<typeof moveSalesDealSchema>;

/** POST /sales/deals/:id/request-won and /confirm-won: the version read. */
export const salesDealVersionSchema = z.object({ version: versionSchema });
export type SalesDealVersionRequest = z.infer<typeof salesDealVersionSchema>;

/** POST /sales/deals/:id/reject-won: the sales manager sends the Won request back, with a reason. */
export const rejectSalesWonSchema = z.object({ reason: decisionReasonSchema, version: versionSchema });
export type RejectSalesWonRequest = z.infer<typeof rejectSalesWonSchema>;

/** GET /sales/deals */
export const salesDealListQuerySchema = pageQuerySchema.extend({
  owner: empIdSchema.optional(),
  stage: salesDealStageSchema.optional(),
  leadId: z.uuid().optional(),
  wonStatus: z.enum(SALES_WON_STATUSES).optional(),
  /** open = every open stage; closed = Won or Lost; all (default). */
  status: z.enum(['open', 'closed', 'all']).default('all'),
});
export type SalesDealListQuery = z.infer<typeof salesDealListQuerySchema>;

export interface SalesDealHistoryView {
  event: SalesDealEvent;
  fromStage: SalesDealStage | null;
  toStage: SalesDealStage;
  by: SalesPersonRef | null;
  at: string;
  reason: string | null;
  note: string | null;
}

/** A deal the caller may see in full (own; the team for the sales manager; all for sales.all). */
export interface SalesDealView {
  restricted: false;
  id: string;
  number: string;
  leadId: string;
  leadName: string;
  company: { id: string; name: string; partyId: string | null };
  owner: SalesPersonRef;
  service: SalesDealService;
  value: string;
  currency: Currency;
  expectedClose: string;
  stage: SalesDealStage;
  nextStep: string | null;
  nextStepDate: string | null;
  /** M15.3: the proposal's link (link only; no files). */
  proposalUrl: string | null;
  lostReason: string | null;
  lostNote: string | null;
  recontactAfter: string | null;
  wonStatus: SalesWonStatus;
  wonRequestedAt: string | null;
  wonRequestedBy: SalesPersonRef | null;
  wonConfirmedAt: string | null;
  wonConfirmedBy: SalesPersonRef | null;
  closedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  /** The caller may confirm or send back the Won request (sales manager, never the owner or the person who asked). */
  canDecideWon: boolean;
}

export interface SalesDealDetailView extends SalesDealView {
  history: SalesDealHistoryView[];
  /** Module 13: the draft invoice made from this Won deal, once the billing reader has handled it. */
  handover: { status: 'drafted' | 'needs_client'; invoiceId: string | null } | null;
  /**
   * M15.5 follow-up: true only for someone who may make the exceptional Won decision (sales.won_decide_exception), and only
   * while every condition holds (the person who asked has left, the deal was moved when they left, nobody else can decide).
   */
  wonExceptionEligible: boolean;
}

/** Someone else's deal: only that it exists and who owns it (no value, no notes). */
export interface SalesDealStubView {
  restricted: true;
  id: string;
  number: string;
  companyName: string;
  owner: SalesPersonRef;
}

export type SalesDealResult = SalesDealDetailView | SalesDealStubView;

/** GET /sales/deals/summary: counts and totals per stage for the deals the caller may see, per currency (no conversion). */
export interface SalesPipelineSummaryView {
  stages: Array<{ stage: SalesDealStage; count: number; totals: Array<{ currency: Currency; value: string }> }>;
  pendingWonCount: number;
}

// =============================================================================================================== M15.3
// Activities, follow-ups and proposal links (plan section 20): every lead and deal shows every contact in time order (who,
// when, typed in by hand or from a connected tool); every open deal's next step is its follow-up; "My follow-ups today";
// a missed follow-up turns red and the sales manager sees it. Module 16 (Apollo, MillionVerifier, mailboxes) adds
// tool-made activities later; Module 15 records manual ones only.

/** What a salesperson logs by hand (plan section 20 "Activity timeline"; Fiverr inquiries by decision of the CTO). */
export const SALES_MANUAL_ACTIVITY_KINDS = ['call', 'email_sent', 'reply', 'meeting', 'linkedin', 'whatsapp', 'fiverr', 'proposal', 'note'] as const;
export const salesManualActivityKindSchema = z.enum(SALES_MANUAL_ACTIVITY_KINDS);
export type SalesManualActivityKind = z.infer<typeof salesManualActivityKindSchema>;
/** Every kind on the timeline: the manual ones and a completed follow-up (written by POST /sales/deals/:id/follow-up). */
export const SALES_ACTIVITY_KINDS = [...SALES_MANUAL_ACTIVITY_KINDS, 'follow_up'] as const;
export type SalesActivityKind = (typeof SALES_ACTIVITY_KINDS)[number];

/** Where an activity came from: typed in by hand, or (Module 16, later) a connected tool. Shown on every entry. */
export const SALES_ACTIVITY_SOURCES = ['manual', 'apollo', 'millionverifier', 'mailbox'] as const;
export type SalesActivitySource = (typeof SALES_ACTIVITY_SOURCES)[number];

/** A logged contact moves an open deal FORWARD to this stage (plan section 20, "The deal moves here when"). */
export const SALES_ACTIVITY_STAGE: Partial<Record<SalesActivityKind, SalesDealStage>> = {
  call: 'contacted',
  email_sent: 'contacted',
  linkedin: 'contacted',
  whatsapp: 'contacted',
  fiverr: 'contacted',
  reply: 'replied',
};
/**
 * The only stages an activity may move a deal FROM, where the plan's order requires it (approved M15.3 decision 2): a
 * reply moves Contacted to Replied, never New straight to Replied (the first contact is logged first).
 */
export const SALES_ACTIVITY_MOVES_FROM: Partial<Record<SalesActivityKind, readonly SalesDealStage[]>> = {
  reply: ['contacted'],
};
/** Why an activity left the stage alone (the activity is kept either way). */
export const SALES_STAGE_NOT_CHANGED_REASONS = ['deal_closed', 'won_pending', 'not_forward', 'needs_contacted'] as const;
export type SalesStageNotChangedReason = (typeof SALES_STAGE_NOT_CHANGED_REASONS)[number];
/** A meeting moves the deal to Meeting booked only when its date is given; a proposal to Proposal sent only when linked. */

const webLink = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.');
    } catch {
      return false;
    }
  }, 'Enter the link as a web address starting with https://');

/**
 * POST /sales/leads/:id/activities and POST /sales/deals/:id/activities: a contact logged by hand. `at` is when it happened
 * (default now; never in the future). meetingAt only for a meeting, proposalUrl only for a proposal.
 */
export const logSalesActivitySchema = z
  .object({
    kind: salesManualActivityKindSchema,
    summary: z.string().trim().min(2, 'Say what happened').max(1000),
    at: z.iso.datetime({ offset: true }).optional(),
    meetingAt: z.iso.datetime({ offset: true }).optional(),
    proposalUrl: webLink.optional(),
  })
  .refine((v) => v.meetingAt === undefined || v.kind === 'meeting', { message: 'A meeting date belongs to a meeting', path: ['meetingAt'] })
  .refine((v) => v.proposalUrl === undefined || v.kind === 'proposal', { message: 'A proposal link belongs to a proposal', path: ['proposalUrl'] });
export type LogSalesActivityRequest = z.input<typeof logSalesActivitySchema>;
export type LogSalesActivityData = z.output<typeof logSalesActivitySchema>;

/** POST /sales/deals/:id/follow-up: the follow-up is done (written as an activity) and the next one is set. */
export const completeSalesFollowUpSchema = z.object({
  summary: z.string().trim().max(1000).optional(),
  nextStep: z.string().trim().min(2, 'Describe the next step').max(300),
  nextStepDate: daySchema,
  version: versionSchema,
});
export type CompleteSalesFollowUpRequest = z.input<typeof completeSalesFollowUpSchema>;
export type CompleteSalesFollowUpData = z.output<typeof completeSalesFollowUpSchema>;

/** GET /sales/follow-ups: mine, or the team's (sales.team); due today, missed (before today), or both. */
export const salesFollowUpListQuerySchema = z.object({
  scope: z.enum(['mine', 'team']).default('mine'),
  status: z.enum(['due', 'missed', 'all']).default('all'),
  owner: empIdSchema.optional(),
});
export type SalesFollowUpListQuery = z.infer<typeof salesFollowUpListQuerySchema>;

export interface SalesActivityView {
  id: string;
  leadId: string;
  dealId: string | null;
  dealNumber: string | null;
  kind: SalesActivityKind;
  source: SalesActivitySource;
  /** When it happened. */
  at: string;
  summary: string;
  meetingAt: string | null;
  proposalUrl: string | null;
  /** Who did it (null only for a tool activity not linked to anyone, Module 16). */
  actor: SalesPersonRef | null;
  /** The tool's own id (Module 16), so a sync never counts the same item twice. Null for manual entries. */
  externalId: string | null;
  createdAt: string;
}

/** The answer to logging an activity: the entry, and what it did to the deal's stage. */
export interface SalesActivityResult {
  activity: SalesActivityView;
  /** The deal moved forward because of this activity. */
  stageChange: { from: SalesDealStage; to: SalesDealStage } | null;
  /**
   * Why a stage change this activity would bring did not happen (the activity is kept either way): the deal is Won or
   * Lost, waits for Won confirmation, is already at or past that stage, or (a reply on a New deal) was not contacted yet.
   */
  stageNotChanged: SalesStageNotChangedReason | null;
}

export interface SalesFollowUpView {
  dealId: string;
  dealNumber: string;
  companyName: string;
  leadId: string;
  leadName: string;
  owner: SalesPersonRef;
  nextStep: string;
  nextStepDate: string;
  /** The date has passed (Pakistan time): shown red, and to the sales manager. */
  missed: boolean;
  /** The deal is waiting for its Won confirmation. */
  wonPending: boolean;
}

// =============================================================================================================== M15.4
/*
 * Module 15.4: the do-not-contact list and the lead import (plan section 20).
 *
 * "An unsubscribe or 'do not contact' request is saved on the lead, and the system blocks that email from every future
 * sequence." Approved M15.4 rules (management decisions 1-6):
 *  - a lead whose email is on the list cannot be added or imported; outgoing contact (call, email sent, LinkedIn, WhatsApp,
 *    meeting, proposal) cannot be logged on a do-not-contact lead; replies and notes still can. Email only;
 *  - entries are never changed or removed, and keep working after the lead is archived;
 *  - the lead's owner or the sales manager marks a lead; only the sales manager adds an email that has no lead;
 *  - the list keeps a keyed hash (HMAC) of the email and a masked form ("a***@domain.com"), never the email itself;
 *  - the import is CSV only, in the existing column format, with a preview first; the uploader picks the source of the
 *    file, a valid source on a row overrides it, an unknown one makes the row invalid; 2 MB, 5,000 rows, 30 minutes.
 */

// ------------------------------------------------------------------------------------------------- do-not-contact list

/** Who put an email on the list: a person in Aceva ("manual"), or later an unsubscribe reported by a tool (Module 16). */
export const SALES_DNC_SOURCES = ['manual', 'apollo', 'mailbox'] as const;
export type SalesDncSource = (typeof SALES_DNC_SOURCES)[number];

/** Outgoing contact that cannot be logged on a do-not-contact lead (approved decision 1). Replies and notes stay allowed. */
export const SALES_DNC_BLOCKED_KINDS = ['call', 'email_sent', 'linkedin', 'whatsapp', 'meeting', 'proposal'] as const;

const dncReasonSchema = z.string().trim().min(3, 'Please give a reason (at least 3 characters)').max(500);

/** POST /sales/leads/:id/do-not-contact (the lead's owner, or the sales manager for their team). */
export const markSalesLeadDncSchema = z.object({ reason: dncReasonSchema });
export type MarkSalesLeadDncRequest = z.infer<typeof markSalesLeadDncSchema>;

/** POST /sales/do-not-contact: an email that has no lead (the sales manager only). */
export const addSalesDncEmailSchema = z.object({
  email: z.string().trim().max(254).pipe(z.email('Enter a valid email address')),
  reason: dncReasonSchema,
});
export type AddSalesDncEmailRequest = z.infer<typeof addSalesDncEmailSchema>;

/** GET /sales/do-not-contact (sales.team or sales.all). */
export const salesDncListQuerySchema = pageQuerySchema;
export type SalesDncListQuery = z.infer<typeof salesDncListQuerySchema>;

/** "a***@domain.com": the first character of the local part, then ***, then the domain. */
export function maskEmail(email: string): string {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf('@');
  if (at < 1) return '***';
  return `${e[0]}***${e.slice(at)}`;
}

export interface SalesDncEntryView {
  id: string;
  /** The masked email ("a***@domain.com"); null for a lead that had no email when it was marked. */
  maskedEmail: string | null;
  /** The lead it was marked on, only when the caller sees that lead in full. */
  lead: { id: string; fullName: string } | null;
  reason: string;
  source: SalesDncSource;
  addedBy: SalesPersonRef | null;
  addedAt: string;
}

// ------------------------------------------------------------------------------------------------------------- import

/** The existing CSV format (the import screen's sample): only these column names, in this order when there is no header. */
export const SALES_IMPORT_COLUMNS = ['name', 'email', 'company', 'website', 'country', 'title', 'source'] as const;
export type SalesImportColumn = (typeof SALES_IMPORT_COLUMNS)[number];
export const SALES_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const SALES_IMPORT_MAX_ROWS = 5000;
export const SALES_IMPORT_PREVIEW_MINUTES = 30;

/** POST /sales/leads/import/preview: multipart, the CSV `file` plus these fields. */
export const salesImportPreviewSchema = z.object({
  /** The source of the whole file; a valid `source` on a row overrides it. */
  source: salesLeadSourceSchema,
  /** Only the sales manager may import leads for someone in their team; everyone else owns what they import. */
  ownerEmpId: empIdSchema.optional(),
});
export type SalesImportPreviewRequest = z.infer<typeof salesImportPreviewSchema>;

/**
 * A row of the preview:
 *  - ok: will be added;
 *  - duplicate: a lead with this email already exists (its owner is shown, as everywhere in Module 15);
 *  - repeated: the same email appears earlier in the file;
 *  - dnc: the email is on the do-not-contact list;
 *  - invalid: something on the row is wrong (each problem is listed).
 */
export const SALES_IMPORT_ROW_STATUSES = ['ok', 'duplicate', 'repeated', 'dnc', 'invalid'] as const;
export type SalesImportRowStatus = (typeof SALES_IMPORT_ROW_STATUSES)[number];

export interface SalesImportRowView {
  /** The line in the file (the header is line 1). */
  line: number;
  name: string;
  email: string | null;
  companyName: string | null;
  website: string | null;
  country: string | null;
  title: string | null;
  source: SalesLeadSource | null;
  status: SalesImportRowStatus;
  problems: string[];
  /** For a duplicate: who owns the existing lead. */
  owner: SalesPersonRef | null;
}

export interface SalesImportPreviewView {
  batchId: string;
  fileName: string;
  source: SalesLeadSource;
  owner: SalesPersonRef;
  expiresAt: string;
  counts: Record<SalesImportRowStatus, number>;
  rows: SalesImportRowView[];
}

/** POST /sales/leads/import/:batchId/commit. Committing the same preview again returns this same result. */
export interface SalesImportResultView {
  batchId: string;
  created: number;
  /** Rows not added. A row that became a duplicate (or do-not-contact) after the preview is skipped, never forced in. */
  skipped: Array<{ line: number; status: Exclude<SalesImportRowStatus, 'ok'> }>;
  committedAt: string;
  committedBy: SalesPersonRef;
}

// =============================================================================================================== M15.5
/*
 * Module 15.5: leads and deals when a salesperson leaves, and archiving inactive leads (plan section 20).
 *
 * "Leads belong to Aceva, not to the salesperson. When someone leaves, their leads and deals move to the sales manager on
 * their last working day (Module 3)." and "Leads with no activity for 12 months are archived and their contact details
 * removed. The period is a setting." Approved M15.5 rules (decisions 7-9):
 *  - the receiver is the one active holder of the sales_manager duty; when there is none or more than one, the leaver's
 *    manager from the event only if active, owning and managing sales leads (sales.own and sales.targets) and not the
 *    CEO / Owner (view-only); otherwise nothing is moved and the case waits for management (SalesReassignmentIssueView);
 *  - the leaver's leads that are not archived and their open deals move, a deal waiting for its Won confirmation too, with
 *    the request kept; Won and Lost deals keep their owner;
 *  - archiving clears email, phone and LinkedIn and keeps notes, the timeline and the audit trail; never a lead with an
 *    open deal (a deal waiting for its Won confirmation is open), a Won client's lead, or a lead at a client company; a
 *    do-not-contact lead may be archived and stays blocked (the list keeps the hash).
 */

/** Why a lead was archived. M15.5 has one reason: no activity for the set number of months. */
export const SALES_ARCHIVE_REASONS = ['inactive'] as const;
export type SalesArchiveReason = (typeof SALES_ARCHIVE_REASONS)[number];

/** The contact details archiving removes (approved decision 9). Notes and the timeline are kept. */
export const SALES_ARCHIVE_CLEARED_FIELDS = ['email', 'phone', 'linkedinUrl'] as const;

export interface SalesLeadArchiveView {
  at: string;
  reason: SalesArchiveReason;
  /** The archive period in force (months without activity). */
  inactiveMonths: number;
  /** The lead's last activity when it was archived. */
  lastActivityAt: string;
  /** Who archived it; null when the nightly job did. */
  by: SalesPersonRef | null;
  clearedFields: string[];
}

/** Why a leaver's leads could not be moved. */
export const SALES_REASSIGNMENT_ISSUE_REASONS = ['no_recipient'] as const;
export type SalesReassignmentIssueReason = (typeof SALES_REASSIGNMENT_ISSUE_REASONS)[number];

/** GET /sales/reassignment-issues (sales.team or sales.all): leavers whose leads and deals are waiting for an owner. */
export interface SalesReassignmentIssueView {
  id: string;
  employee: SalesPersonRef;
  reason: SalesReassignmentIssueReason;
  /** Plain words: how many sales managers were found, and why the leaver's manager could not receive them. */
  detail: string;
  /** Still owned by the leaver now (not archived). */
  openLeads: number;
  openDeals: number;
  createdAt: string;
}

// ===================================================================================================== M15.5 follow-up
/*
 * The exceptional Won decision (approved management decision, M15.5 follow-up). When the person who asked for Won has left
 * and Module 15.5 moved the deal to someone else, the request can be stranded: B1 lets the CEO / Owner confirm only a deal a
 * Director owns, the new owner never decides their own deal, and there may be no sales manager above them. The holder of
 * sales.won_decide_exception (the Owner role only) may then confirm it or send it back, with a reason and step-up
 * re-authentication, on POST /sales/deals/:id/won-exception, only while every condition holds:
 *  - the deal is open and its Won request pending;
 *  - the person who asked has left (Module 3 offboarding) and the deal was moved to someone else after the request;
 *  - the deal is not one a Director owns (B1 applies to those), and no sales manager can decide it the normal way;
 *  - the decider is neither the current owner nor the person who asked.
 * Nothing is decided automatically. Each decision is kept in an insert-only record with the original request.
 */
export const SALES_WON_EXCEPTION_DECISIONS = ['confirm', 'send_back'] as const;
export type SalesWonExceptionDecision = (typeof SALES_WON_EXCEPTION_DECISIONS)[number];

export const decideSalesWonExceptionSchema = z.object({
  decision: z.enum(SALES_WON_EXCEPTION_DECISIONS),
  reason: decisionReasonSchema,
  version: versionSchema,
});
export type DecideSalesWonExceptionRequest = z.infer<typeof decideSalesWonExceptionSchema>;
