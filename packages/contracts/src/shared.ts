import { z } from 'zod';

/**
 * Small primitives shared by the M7, M8 and M9 contracts (owner: Track A). Module contract files import these instead of
 * defining their own, so a day, a month or an amount means the same thing everywhere.
 */

/** A Pakistan calendar day, 'YYYY-MM-DD'. */
export const daySchema = z.iso.date();

/** A month, 'YYYY-MM'. */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month looks like 2026-11');

/** A time of day in Pakistan, 'HH:MM' (24 hours). */
export const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time looks like 09:15');

/**
 * Money as a decimal STRING with at most 2 decimals (never a float), e.g. "1250.00".
 * Responses always carry exactly 2 decimals.
 */
export const moneySchema = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, 'An amount looks like 1250.00');

/** A positive amount. */
export const positiveMoneySchema = moneySchema.refine((v) => Number(v) > 0, 'The amount must be more than zero');

/** An exchange rate: PKR for 1 unit of the currency, up to 6 decimals. */
export const rateSchema = z.string().trim().regex(/^\d{1,9}(\.\d{1,6})?$/, 'A rate looks like 278.500000').refine((v) => Number(v) > 0, 'The rate must be more than zero');

export const currencySchema = z.enum(['PKR', 'USD']);
export type Currency = z.infer<typeof currencySchema>;

/** Decisions that refuse something always need a reason (5 to 500 characters). */
export const decisionReasonSchema = z.string().trim().min(5, 'Please give a reason (at least 5 characters)').max(500);

/** An optional note on an approval. */
export const decisionNoteSchema = z.object({ note: z.string().trim().max(500).optional() });
export const rejectSchema = z.object({ reason: decisionReasonSchema });

/** A page of results (spec section 7.2). */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
