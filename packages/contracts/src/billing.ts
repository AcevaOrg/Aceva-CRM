import { z } from 'zod';
import { empIdSchema } from './events';
import type { EntryStatus } from './ledger';
import { currencySchema, daySchema, decisionReasonSchema, moneySchema, monthSchema, pageQuerySchema, positiveMoneySchema, rateSchema } from './shared';

/**
 * Module 13: customer billing, subscriptions and renewal management (plan section 18).
 * Invoices, their lines and payments are Module 9's (one invoice system); Module 13 adds the life cycle around them:
 * draft -> issued (the ledger entry is created and waits for approval in Module 9) -> cancelled (a reversing entry when it
 * was posted). Paid, part paid and overdue are calculated from posted payments, never stored. No sales tax (decision D13).
 */

const uuid = z.uuid();
const text = (max: number) => z.string().trim().min(1, 'Required').max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

export const invoiceKindSchema = z.enum(['one_time', 'recurring', 'rental']);
export type InvoiceKind = z.infer<typeof invoiceKindSchema>;
export const billingPeriodSchema = z.enum(['monthly', 'quarterly', 'yearly']);
export type BillingPeriod = z.infer<typeof billingPeriodSchema>;

/** Days relative to the due date: -3 = 3 days before, 0 = on the due date, 7 = 7 days after. */
export const reminderOffsetsSchema = z
  .array(z.number().int().min(-60).max(120))
  .max(8)
  .refine((v) => new Set(v).size === v.length, 'Each reminder day only once');

/** The approved reminder timing (development default until management changes it in settings). */
export const DEFAULT_REMINDER_OFFSETS = [-3, 0, 3, 7] as const;

/** How a payment was made. Payment-card details are never stored: only the method and a reference. */
export const paymentMethodSchema = z.enum(['bank_transfer', 'cash', 'cheque', 'card_provider', 'other']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

const quantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,8}(\.\d{1,2})?$/, 'A quantity looks like 1 or 2.5')
  .refine((v) => Number(v) > 0, 'The quantity must be more than zero');

export const billingLineSchema = z.object({
  description: text(300),
  quantity: quantitySchema,
  unitPrice: moneySchema,
  /** The income account credited. Missing = the default income account in the billing settings. */
  accountId: uuid.optional(),
});

const invoiceFields = {
  partyId: uuid,
  kind: invoiceKindSchema.default('one_time'),
  /** Recurring and rental: how often it is billed. */
  period: billingPeriodSchema.optional(),
  /** Recurring and rental: the first billed period starts here (default: the issue date). */
  periodStart: daySchema.optional(),
  /** Recurring and rental: the last day billed (missing = until stopped). */
  periodEnd: daySchema.optional(),
  /** The planned issue date; issuing can move it to the day it is issued. */
  issueDate: daySchema,
  termsDays: z.number().int().min(0).max(365),
  currency: currencySchema.default('PKR'),
  projectId: uuid.optional(),
  notes: optionalText(1000),
  lines: z.array(billingLineSchema).min(1).max(100),
  reminderOffsets: reminderOffsetsSchema.optional(),
  /** The staff member reminded about it (default: the person who creates it). */
  assignedToEmpId: empIdSchema.optional(),
};

const recurringNeedsPeriod = (v: { kind: InvoiceKind; period?: BillingPeriod; periodStart?: string; periodEnd?: string; issueDate: string }) =>
  v.kind === 'one_time' ? !v.period && !v.periodEnd : !!v.period;

/** POST /billing/invoices: a DRAFT (no ledger entry). requestKey makes a retry return the same draft. */
export const createBillingInvoiceSchema = z
  .object({ requestKey: uuid, ...invoiceFields })
  .refine(recurringNeedsPeriod, { message: 'Recurring and rental invoices need a billing period; one-time invoices have none', path: ['period'] })
  .refine((v) => !v.periodEnd || v.periodEnd >= (v.periodStart ?? v.issueDate), { message: 'The end cannot be before the start', path: ['periodEnd'] });
export type CreateBillingInvoice = z.infer<typeof createBillingInvoiceSchema>;

/** PATCH /billing/invoices/:id: a draft only (the whole editable content). */
export const updateBillingInvoiceSchema = z
  .object({ ...invoiceFields })
  .omit({ kind: true, period: true, periodEnd: true })
  .strict();
export type UpdateBillingInvoice = z.infer<typeof updateBillingInvoiceSchema>;

/** POST /billing/invoices/:id/issue. Default issue date: today. The due date is the issue date plus the terms. */
export const issueInvoiceSchema = z
  .object({
    issueDate: daySchema.optional(),
    /** USD invoices: PKR per 1 USD. Missing = the rate saved for the issue date. */
    exchangeRate: rateSchema.optional(),
  })
  .strict();
export type IssueInvoice = z.infer<typeof issueInvoiceSchema>;

export const cancelInvoiceSchema = z.object({ reason: decisionReasonSchema }).strict();

/** Digits that look like a payment card number (13 to 19 digits, spaces or dashes allowed) are refused in references. */
export const looksLikeCardNumber = (s: string): boolean => {
  const digits = s.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
};

/** True when any run of digits in the text is a valid card number. */
export const containsCardNumber = (s: string): boolean => (s.match(/\d[\d -]{11,24}\d/g) ?? []).some(looksLikeCardNumber);

/** POST /billing/invoices/:id/payments. The payment is Module 9's: its entry waits for approval like every entry. */
export const recordInvoicePaymentSchema = z
  .object({
    requestKey: uuid,
    bankAccountId: uuid,
    date: daySchema,
    amount: positiveMoneySchema,
    method: paymentMethodSchema,
    reference: optionalText(80).refine((v) => !v || !containsCardNumber(v), 'Never enter a card number. Use the payment provider reference instead.'),
    exchangeRate: rateSchema.optional(),
  })
  .strict();
export type RecordInvoicePayment = z.infer<typeof recordInvoicePaymentSchema>;

export const billingInvoiceStatusSchema = z.enum(['draft', 'issued', 'part_paid', 'paid', 'overdue', 'cancelled']);
export type BillingInvoiceStatus = z.infer<typeof billingInvoiceStatusSchema>;

export const billingInvoiceListQuerySchema = pageQuerySchema.extend({
  partyId: uuid.optional(),
  status: billingInvoiceStatusSchema.or(z.literal('all')).optional(),
});

export interface BillingReminderView {
  id: string;
  offsetDays: number;
  audience: 'customer' | 'staff';
  scheduledFor: string;
  status: 'scheduled' | 'sent' | 'skipped';
  reason: string | null;
  sentAt: string | null;
}

export interface BillingInvoiceView {
  id: string;
  /** DRAFT-xxxxxxxx until issued, then INV-YYYY-NNNN. */
  number: string;
  partyId: string;
  partyName: string;
  kind: InvoiceKind;
  period: BillingPeriod | null;
  periodStart: string | null;
  periodEnd: string | null;
  recurringRuleId: string | null;
  issueDate: string;
  dueDate: string;
  termsDays: number | null;
  currency: 'PKR' | 'USD';
  exchangeRate: string;
  total: string;
  /** Paid by POSTED payments. */
  paid: string;
  /** Recorded payments still waiting for approval. */
  pendingPayments: string;
  /** Total minus posted payments. */
  balance: string;
  /** Calculated (draft, issued, part paid, paid, overdue, cancelled). */
  status: BillingInvoiceStatus;
  reminderOffsets: number[];
  assignedToEmpId: string | null;
  createdByEmpId: string | null;
  createdAt: string;
  issuedAt: string | null;
  issuedByEmpId: string | null;
  emailedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  entryId: string | null;
  entryNumber: string | null;
  entryStatus: EntryStatus | null;
  cancelEntryNumber: string | null;
  cancelEntryStatus: EntryStatus | null;
  sourceDealNumber: string | null;
  sourceDealOwnerEmpId: string | null;
  projectId: string | null;
  notes: string | null;
  lines: { lineNo: number; description: string; quantity: string; unitPrice: string; amount: string; accountId: string; accountCode: string }[];
}

export interface BillingPaymentView {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  partyId: string;
  date: string;
  currency: 'PKR' | 'USD';
  /** The part of the payment allocated to this invoice. */
  amount: string;
  method: string | null;
  reference: string | null;
  bankAccountName: string;
  entryNumber: string | null;
  entryStatus: EntryStatus | null;
  recordedByEmpId: string | null;
  recordedAt: string;
}

export interface BillingInvoiceDetailView {
  invoice: BillingInvoiceView;
  customer: BillingCustomerView;
  payments: BillingPaymentView[];
  reminders: BillingReminderView[];
  emails: { id: string; kind: 'invoice' | 'reminder'; reminderOffset: number | null; status: string; note: string | null; sentAt: string | null; createdAt: string }[];
  recurringRule: RecurringRuleView | null;
}

// ------------------------------------------------------------------------------------------------ customers

export const billingCustomerSchema = z
  .object({
    name: text(200),
    contactName: optionalText(200),
    email: z.email().max(200).optional().or(z.literal('').transform(() => undefined)),
    phone: optionalText(40),
    country: optionalText(80),
    address: optionalText(500),
    currency: currencySchema.default('PKR'),
    termsDays: z.number().int().min(0).max(365).optional(),
    taxId: optionalText(80),
    notes: optionalText(1000),
  })
  .strict();
export type BillingCustomerInput = z.infer<typeof billingCustomerSchema>;
export const updateBillingCustomerSchema = billingCustomerSchema.partial().strict();

export interface BillingCustomerView {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  address: string | null;
  currency: 'PKR' | 'USD';
  termsDays: number;
  taxId: string | null;
  notes: string | null;
  totalBilled: string;
  outstanding: string;
  invoiceCount: number;
  lastPaymentAt: string | null;
  /** Created automatically from a Won deal: Finance reviews it (POST /billing/customers/:id/confirm) before its invoice can be issued. */
  needsReview: boolean;
  createdFromDeal: string | null;
}

// ------------------------------------------------------------------------------------------------ Won deals (Module 15 connection point)

/**
 * A confirmed Won deal received by billing. drafted: its draft invoice exists. needs_client: two or more clients have exactly
 * the deal's client name, so Finance chooses the right one (POST /billing/deal-handovers/:id/resolve); billing never picks one.
 */
export interface DealHandoverView {
  id: string;
  dealNumber: string;
  status: 'drafted' | 'needs_client';
  clientName: string;
  service: string;
  value: string;
  currency: 'PKR' | 'USD';
  ownerEmpId: string;
  candidates: { id: string; name: string; email: string | null; country: string | null }[];
  invoiceId: string | null;
  createdAt: string;
}

export const resolveDealHandoverSchema = z.object({ partyId: uuid }).strict();
export const dealHandoverListQuerySchema = z.object({ status: z.enum(['drafted', 'needs_client', 'all']).optional() });

// ------------------------------------------------------------------------------------------------ recurring rules

export interface RecurringRuleView {
  id: string;
  partyId: string;
  partyName: string;
  kind: 'recurring' | 'rental';
  period: BillingPeriod;
  currency: 'PKR' | 'USD';
  total: string;
  startDate: string;
  endDate: string | null;
  nextPeriodStart: string | null;
  status: 'active' | 'ended';
  endReason: string | null;
  invoiceCount: number;
}

export const stopRecurringSchema = z.object({ reason: decisionReasonSchema }).strict();

// ------------------------------------------------------------------------------------------------ overview

export interface BillingOverviewView {
  /** PKR: USD invoices at their own rate. */
  billedThisMonth: string;
  collectedThisMonth: string;
  outstanding: string;
  overdueCount: number;
  overdueAmount: string;
  upcomingDue: BillingInvoiceView[];
  overdue: BillingInvoiceView[];
  draftsFromSales: BillingInvoiceView[];
  /** Won deals waiting for Finance to choose their client (ambiguous names). */
  dealsNeedingClient: DealHandoverView[];
  drafts: number;
  history: { month: string; billed: string; collected: string }[];
  /** The latest saved USD rate (PKR per 1 USD), or null. */
  usdRate: string | null;
  customerEmailsEnabled: boolean;
}

// ------------------------------------------------------------------------------------------------ subscriptions

export const subscriptionCategorySchema = z.enum(['sales_tools', 'domains_email', 'ai', 'hosting', 'api', 'dev_tools', 'crm']);
export const subscriptionPeriodSchema = z.enum(['monthly', 'quarterly', 'yearly', 'usage']);

const decimalSchema = z.string().trim().regex(/^\d{1,12}(\.\d{1,4})?$/, 'A number looks like 1500 or 12.5');

export const subscriptionSchema = z
  .object({
    vendor: text(120),
    product: text(160),
    category: subscriptionCategorySchema,
    ownerEmpId: empIdSchema,
    plan: text(160),
    cost: moneySchema,
    currency: currencySchema,
    period: subscriptionPeriodSchema,
    renewalDate: daySchema,
    alertDaysBefore: z.number().int().min(0).max(365),
    seats: z.number().int().min(0).max(100000).optional(),
    usageMetric: optionalText(80),
    usageUnit: optionalText(40),
    usageLimit: decimalSchema.refine((v) => Number(v) > 0, 'The limit must be more than zero').optional(),
    notes: optionalText(1000),
  })
  .strict();
export type SubscriptionInput = z.infer<typeof subscriptionSchema>;
/** PATCH /billing/subscriptions/:id: details only. Renewing, changing the plan or cost, and cancelling are renewal decisions. */
export const updateSubscriptionSchema = subscriptionSchema.omit({ cost: true, currency: true, renewalDate: true, plan: true }).partial().strict();

export const renewalDecisionSchema = z
  .object({
    decision: z.enum(['renewed', 'changed', 'cancelled']),
    note: optionalText(500),
    /** Renewed or changed: the next renewal date (default: one period later). */
    nextRenewalDate: daySchema.optional(),
    /** Changed: the new plan and cost. */
    newPlan: optionalText(160),
    newCost: moneySchema.optional(),
    newPeriod: subscriptionPeriodSchema.optional(),
  })
  .strict()
  .refine((v) => v.decision !== 'changed' || !!(v.newPlan || v.newCost || v.newPeriod), { message: 'Say what changed (plan, cost or period)', path: ['newCost'] })
  .refine((v) => v.decision !== 'cancelled' || !!v.note, { message: 'Give a short note on why it is cancelled', path: ['note'] });

/** POST /billing/subscriptions/:id/usage: a reading typed in by hand (no provider API is connected). */
export const usageReadingSchema = z
  .object({
    readingDate: daySchema,
    used: decimalSchema,
    limit: decimalSchema.refine((v) => Number(v) > 0, 'The limit must be more than zero').optional(),
    /** Always shown as "Estimated". */
    estimatedCost: moneySchema.optional(),
    note: optionalText(500),
  })
  .strict();

/** PUT /billing/subscriptions/:id/costs/:month. Estimated unless backed by a Module 9 bill or the provider's invoice reference. */
export const subscriptionCostSchema = z
  .object({
    amount: moneySchema,
    currency: currencySchema,
    estimated: z.boolean(),
    billId: uuid.optional(),
    reference: optionalText(120),
    note: optionalText(500),
  })
  .strict()
  .refine((v) => v.estimated || !!v.billId || !!v.reference, { message: 'An actual cost needs the bill or the provider invoice reference; otherwise mark it estimated', path: ['estimated'] });

export const costMonthParamSchema = z.object({ month: monthSchema });

export interface UsageReadingView {
  id: string;
  readingDate: string;
  used: string;
  limit: string | null;
  estimatedCost: string | null;
  source: 'manual' | 'api';
  note: string | null;
  enteredByEmpId: string | null;
  createdAt: string;
}

export interface SubscriptionCostView {
  id: string;
  month: string;
  amount: string;
  currency: 'PKR' | 'USD';
  estimated: boolean;
  billId: string | null;
  reference: string | null;
  note: string | null;
  enteredByEmpId: string | null;
  updatedAt: string;
}

export interface RenewalEventView {
  id: string;
  subscriptionId: string;
  kind: 'alert' | 'renewed' | 'changed' | 'cancelled';
  renewalDate: string;
  newRenewalDate: string | null;
  oldCost: string | null;
  newCost: string | null;
  oldPlan: string | null;
  newPlan: string | null;
  note: string | null;
  byEmpId: string | null;
  at: string;
}

export interface SubscriptionView {
  id: string;
  number: string;
  vendor: string;
  product: string;
  category: z.infer<typeof subscriptionCategorySchema>;
  ownerEmpId: string;
  plan: string;
  cost: string;
  currency: 'PKR' | 'USD';
  period: z.infer<typeof subscriptionPeriodSchema>;
  renewalDate: string;
  alertDaysBefore: number;
  seats: number | null;
  usageMetric: string | null;
  usageUnit: string | null;
  usageLimit: string | null;
  notes: string | null;
  /** active | renewing_soon (inside the alert window) | changed (last decision) | cancelled. */
  status: 'active' | 'renewing_soon' | 'changed' | 'cancelled';
  /** The latest readings, oldest first (at most 7). */
  usage: UsageReadingView[];
  /** near_limit (80 % or more of the limit) or unusual (the latest rise is more than 1.5x the earlier average). */
  usageFlag: 'near_limit' | 'unusual' | null;
  costs: SubscriptionCostView[];
}

// ------------------------------------------------------------------------------------------------ settings

/**
 * Module settings "billing" (GET/PUT /settings/modules/billing; changed by settings.manage with "confirm again").
 * NOTHING here is invented: the company details and the sending address are empty until management enters the real ones,
 * and customer emails cannot be switched on before that.
 */
export const billingSettingsSchema = z
  .object({
    company: z
      .object({
        legalName: z.string().trim().max(200).nullable(),
        address: z.string().trim().max(500).nullable(),
        email: z.email().max(200).nullable(),
        phone: z.string().trim().max(40).nullable(),
        /** NTN / STRN or similar, as printed on invoices. */
        taxNumbers: z.string().trim().max(200).nullable(),
        /** Bank details printed on invoices for payment. */
        paymentDetails: z.string().trim().max(1000).nullable(),
      })
      .strict(),
    customerEmails: z
      .object({
        enabled: z.boolean(),
        /** A real Aceva mailbox (for example billing@ the company domain). */
        fromAddress: z.email().max(200).nullable(),
        replyTo: z.email().max(200).nullable(),
      })
      .strict(),
    reminderOffsets: reminderOffsetsSchema,
    defaultTermsDays: z.number().int().min(0).max(365),
    /** The income account used when an invoice line names none (a 4xxx code from the chart of accounts). */
    defaultIncomeAccountCode: z.string().trim().regex(/^\d{4,6}$/).nullable(),
  })
  .strict()
  .refine((v) => !v.customerEmails.enabled || (!!v.customerEmails.fromAddress && !!v.company.legalName), {
    message: 'Customer emails need the sending address and the company legal name first',
    path: ['customerEmails', 'enabled'],
  });
export type BillingSettings = z.infer<typeof billingSettingsSchema>;

export const BILLING_SETTINGS_DEFAULTS: BillingSettings = {
  company: { legalName: null, address: null, email: null, phone: null, taxNumbers: null, paymentDetails: null },
  customerEmails: { enabled: false, fromAddress: null, replyTo: null },
  reminderOffsets: [...DEFAULT_REMINDER_OFFSETS],
  // DEVELOPMENT DEFAULTS, configurable, NOT confirmed accounting policy (review decision 3): 14 days' terms, and 4100
  // "Service income" from the seeded chart of accounts. Management and the accountant confirm the real values.
  defaultTermsDays: 14,
  defaultIncomeAccountCode: '4100',
};
