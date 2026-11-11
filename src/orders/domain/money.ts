/**
 * Money is handled in integer cents so sums and conversions do not drift
 * (0.1 * 3 is 0.30000000000000004 in floating point).
 * Assumes two decimal places, which covers the currencies Frankfurter converts.
 */
export const toCents = (amount: number): number => Math.round(amount * 100);

export const fromCents = (cents: number): number => cents / 100;
