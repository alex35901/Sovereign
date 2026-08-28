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
