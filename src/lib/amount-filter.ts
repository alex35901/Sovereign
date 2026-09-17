import { parseMoney, toInput } from "./money.js";

/**
 * Money as a thing to search on and to filter by.
 *
 * Both halves work on the amount as it is shown: signed, with what leaves an
 * account negative. That is the one convention the whole app uses, on the
 * rows, in the totals and in the dialog, and a filter that quietly meant
 * something else would be a filter nobody could predict.
 */

/**
 * Anything that is a number and nothing else: "$1,234.56", "-3,120", "(45.10)".
 *
 * A trailing point and a single decimal are allowed because both are things
 * somebody is halfway through typing. A box that stops matching between
 * "3132" and "3132.8" is a box that flickers.
 */
const LOOKS_LIKE_MONEY = /^[-+]?\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d{0,2})?$|^\(\$?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d{0,2})?\)$/;

export interface TypedAmount {
  /** The figure, in cents, signed as typed. */
  cents: number;
  /** Which direction, when one was actually typed rather than assumed. */
  sign: -1 | 1 | null;
  /** The figure as a plain decimal with nothing else in it: "3132.8". */
  digits: string;
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
  const negative = /^[-(]/.test(text);
  return {
    cents,
    sign: negative ? -1 : /^\+/.test(text) ? 1 : null,
    // Everything that is not the figure itself taken out, so what is left can
    // be compared against a figure written the same way.
    digits: text.replace(/[-+$,()\s]/g, ""),
  };
}

/**
 * Whether a transaction is the figure being typed.
 *
 * Matched as far as it has been typed rather than as a finished number. A
 * search box is filled in one key at a time, and one that only matches the
 * whole figure drops to nothing on the way to it: "31" found the mortgage by
 * its name, "313" found neither the name nor $313.00, and the list emptied
 * three characters into a figure that was really there.
 *
 * The decimal point counts, so "31.32" is thirty-one dollars and does not
 * match three thousand. A sign that was typed is meant: "-3,120" is money that
 * went out and should not turn up rent coming in. One that was not typed is
 * not assumed either way, so "14.49" finds the charge whichever way it went.
 */
export function amountMatches(amount: number, typed: TypedAmount): boolean {
  if (typed.sign !== null && (amount < 0 ? -1 : 1) !== typed.sign) return false;
  return toInput(Math.abs(amount)).startsWith(typed.digits);
}

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
