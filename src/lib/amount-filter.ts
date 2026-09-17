import { parseMoney } from "./money.js";

/**
 * Money as a thing to search on and to filter by.
 *
 * Both halves work on the amount as it is shown: signed, with what leaves an
 * account negative. That is the one convention the whole app uses, on the
 * rows, in the totals and in the dialog, and a filter that quietly meant
 * something else would be a filter nobody could predict.
 */

/** Anything that is a number and nothing else: "$1,234.56", "-3,120", "(45.10)". */
const LOOKS_LIKE_MONEY = /^[-+]?\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$|^\(\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?\)$/;

export interface TypedAmount {
  /** The figure, in cents, signed as typed. */
  cents: number;
  /** Whether a sign was actually given, rather than assumed. */
  signed: boolean;
}

/**
 * A figure somebody typed into the search box, if that is what they typed.
 *
 * Null for anything that is not purely a number, so searching for a merchant
 * still searches for a merchant. The whole string has to be the figure:
 * "2026-09" is a date somebody is looking for, not twenty-six dollars.
 */
export function typedAmount(raw: string): TypedAmount | null {
  const text = raw.trim();
  if (!text || !LOOKS_LIKE_MONEY.test(text)) return null;
  const cents = parseMoney(text);
  if (!Number.isFinite(cents)) return null;
  return { cents, signed: /^[-+]/.test(text) || /^\(/.test(text) };
}

/**
 * Whether a transaction is the figure that was typed.
 *
 * A sign that was typed is meant: "-3,120" is money that went out and should
 * not turn up rent coming in. One that was not is not assumed either way, so
 * "14.49" finds the charge whichever direction it went.
 */
export const amountMatches = (amount: number, typed: TypedAmount): boolean =>
  typed.signed ? amount === typed.cents : Math.abs(amount) === Math.abs(typed.cents);

export interface AmountRange {
  /** Cents, signed, and either end may be left out. */
  min?: number | null;
  max?: number | null;
}

export const hasAmountRange = (r: AmountRange): boolean =>
  r.min !== null && r.min !== undefined ? true : r.max !== null && r.max !== undefined;

/**
 * Whether an amount falls in the range asked for.
 *
 * One end on its own is a half-open range, which is the useful thing when the
 * question is "anything over five hundred". The two are swapped when they
 * arrive the wrong way round rather than matching nothing: somebody who types
 * a bigger number into the first box meant the range between them, and an
 * empty list is a worse answer than the obvious one.
 */
export function inAmountRange(amount: number, r: AmountRange): boolean {
  const a = r.min ?? null;
  const b = r.max ?? null;
  if (a === null && b === null) return true;
  if (a !== null && b !== null) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return amount >= lo && amount <= hi;
  }
  if (a !== null) return amount >= a;
  return amount <= (b as number);
}
