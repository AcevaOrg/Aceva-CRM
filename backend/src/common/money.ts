import { Prisma } from '../generated/prisma/client';

/**
 * Money is exact decimals (plan section 22), never JavaScript floating point.
 * Every money calculation on the server uses these helpers; API responses carry money as 2-decimal strings.
 */
export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

export type DecimalInput = Prisma.Decimal | string | number;

export const ZERO = new Prisma.Decimal(0);

export function dec(value: DecimalInput | null | undefined): Prisma.Decimal {
  if (value === null || value === undefined || value === '') return ZERO;
  return new Prisma.Decimal(value);
}

/** Rounds to paisa (2 decimals), half away from zero. */
export function round2(value: DecimalInput): Prisma.Decimal {
  return dec(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** The API form of an amount: a string with exactly 2 decimals, e.g. "1250.00". */
export function money(value: DecimalInput | null | undefined): string {
  return round2(dec(value)).toFixed(2);
}

export function sum(values: Iterable<DecimalInput>): Prisma.Decimal {
  let total = ZERO;
  for (const v of values) total = total.plus(dec(v));
  return total;
}

export function maxDec(a: DecimalInput, b: DecimalInput): Prisma.Decimal {
  return Prisma.Decimal.max(dec(a), dec(b));
}

export function minDec(a: DecimalInput, b: DecimalInput): Prisma.Decimal {
  return Prisma.Decimal.min(dec(a), dec(b));
}
