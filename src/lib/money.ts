/** Cents in, display string out. */
export function fmt(cents: number, opts: { cents?: boolean; sign?: boolean; compact?: boolean } = {}): string {
  const { cents: showCents = true, sign = false, compact = false } = opts;
  const neg = cents < 0;
  const abs = Math.abs(cents) / 100;
  let body: string;
  if (compact && abs >= 1000) {
    body = abs >= 1_000_000
      ? `${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
      : `${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
    body = `$${body}`;
  } else {
    body = abs.toLocaleString("en-US", {
      style: "currency", currency: "USD",
      minimumFractionDigits: showCents ? 2 : 0,
      maximumFractionDigits: showCents ? 2 : 0,
    });
  }
  if (neg) return `-${body}`;
  return sign ? `+${body}` : body;
}

/** Whole-dollar display, the default for headline figures. */
export const fmt0 = (c: number, o: Parameters<typeof fmt>[1] = {}) => fmt(c, { cents: false, ...o });

/** "1,234.56" or "-1,234.56" — for editable inputs. */
export const toInput = (cents: number): string => (cents / 100).toFixed(2);

/** Accepts "$1,234.56", "(12.30)", "1.2k", "-45" → cents. */
export function parseMoney(raw: string): number {
  if (!raw) return 0;
  let s = raw.trim().replace(/[$,\s]/g, "");
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { neg = true; s = s.slice(1); }
  let mult = 1;
  if (/k$/i.test(s)) { mult = 1000; s = s.slice(0, -1); }
  else if (/m$/i.test(s)) { mult = 1_000_000; s = s.slice(0, -1); }
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * mult * 100) * (neg ? -1 : 1);
}

export const pct = (part: number, whole: number): number => (whole === 0 ? 0 : (part / whole) * 100);
export const fmtPct = (n: number, digits = 1): string => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(digits)}%`;
export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/* ── how loudly a figure wears its colour ──────────────────────────────── */

/**
 * The smallest share of the tone any coloured figure keeps.
 *
 * Not zero. The point of colouring a ledger at all is that direction can be
 * read without looking at a minus sign, and a four dollar coffee in plain ink
 * says nothing. A fifth of the way is a tint rather than a statement.
 */
export const TONE_FLOOR = 0.22;

/**
 * Where the ramp starts and where it is fully saturated, in cents.
 *
 * Read logarithmically between the two, because money does not spread evenly:
 * a household's transactions run from a four dollar coffee to a four thousand
 * dollar mortgage payment, and on a straight scale every ordinary expense
 * would sit in the bottom tenth and look identical. A log scale gives the
 * hundreds the same share of the ramp as the thousands.
 *
 * Fixed rather than taken from whatever is on screen. Scaling to the largest
 * row in view would make the biggest coffee in a filtered list of coffees as
 * loud as a mortgage payment, which is the one thing this must not say.
 */
export const TONE_FROM = 25_00;
export const TONE_TO = 5_000_00;

/**
 * How strongly an amount should wear its tone, from 0 to 1.
 *
 * Sign is not its subject: which colour to use is the caller's business and
 * this answers only how much of it. So it reads the size and nothing else.
 */
export function toneWeight(cents: number, from: number = TONE_FROM, to: number = TONE_TO): number {
  const size = Math.abs(cents);
  // Finite only. A zero needs no guard of its own, because it is below `from`
  // and leaves by the clamp below; a NaN passes both clamps and would come out
  // the other end as a NaN, which reaches the page as a colour nobody can name.
  if (!Number.isFinite(size)) return TONE_FLOOR;
  if (size >= to) return 1;
  if (size <= from) return TONE_FLOOR;
  // No guard against a `to` at or below `from`: the two returns above already
  // cover everything in that case, since a size below `to` is then also below
  // `from` and leaves by the first of them.
  const along = (Math.log(size) - Math.log(from)) / (Math.log(to) - Math.log(from));
  return TONE_FLOOR + (1 - TONE_FLOOR) * along;
}
