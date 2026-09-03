import type { ISODate } from "../types.js";
import { bucketSpan } from "./buckets.js";
import { monthLabel } from "./date.js";

/**
 * The span of dates a list is being narrowed to.
 *
 * A year and a month are the periods a chart already understands, so they
 * borrow bucketSpan rather than growing a second calendar here. "Between" is
 * the one that is genuinely different, and the one worth being careful with:
 * half of it filled in is the common case — "everything since March", "up to
 * the end of last year" — and refusing that until both ends are typed would
 * make it useless for exactly the question people bring to it.
 */

export type DateFilter =
  | { kind: "all" }
  | { kind: "year"; year: string }
  | { kind: "month"; month: string }
  | { kind: "between"; from: string; to: string };

export const ALL: DateFilter = { kind: "all" };

export const FILTER_KINDS: { value: DateFilter["kind"]; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "year", label: "Year" },
  { value: "month", label: "Month" },
  { value: "between", label: "Between dates" },
];

/** Sorts before every real date, and after every real one. */
const DAWN = "0000-01-01";
const DUSK = "9999-12-31";

export interface Bounds { from: ISODate; to: ISODate }

/**
 * The dates a filter admits, or null when it admits everything.
 *
 * Null rather than the widest possible pair so a caller can skip the
 * comparison entirely on the common case, and so "all time" is one thing
 * rather than a magic pair of dates.
 */
export function bounds(f: DateFilter): Bounds | null {
  switch (f.kind) {
    case "all":
      return null;
    case "year":
      return /^\d{4}$/.test(f.year) ? bucketSpan(f.year, "year") : null;
    case "month":
      return /^\d{4}-\d{2}$/.test(f.month) ? bucketSpan(f.month, "month") : null;
    case "between": {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(f.from) ? f.from : "";
      const to = /^\d{4}-\d{2}-\d{2}$/.test(f.to) ? f.to : "";
      if (!from && !to) return null;
      // Typed backwards is a slip, not an empty result: nobody means "no
      // transactions" by it, and swapping is what they would do themselves.
      if (from && to && from > to) return { from: to, to: from };
      return { from: from || DAWN, to: to || DUSK };
    }
  }
}

/** Whether a date is inside. */
export function admits(f: DateFilter, date: ISODate): boolean {
  const b = bounds(f);
  return b === null || (date >= b.from && date <= b.to);
}

/** Whether anything is being narrowed at all, for a "filters applied" count. */
export const isNarrowed = (f: DateFilter): boolean => bounds(f) !== null;

/** What the filter bar says it is doing, in words. */
export function describe(f: DateFilter): string {
  const b = bounds(f);
  if (!b) return "All time";
  if (f.kind === "year") return f.year;
  if (f.kind === "month") return monthLabel(f.month);
  if (b.from === DAWN) return `Up to ${b.to}`;
  if (b.to === DUSK) return `From ${b.from}`;
  return `${b.from} to ${b.to}`;
}

/* ── the URL ──────────────────────────────────────────────────────────── */

/**
 * Read out of a query string.
 *
 * `month` is read as it always was, because links from the Budget screen and
 * anything anyone has bookmarked still carry it.
 */
export function fromParams(get: (k: string) => string | null): DateFilter {
  const from = get("from") ?? "";
  const to = get("to") ?? "";
  if (from || to) return { kind: "between", from, to };
  const year = get("year") ?? "";
  if (year) return { kind: "year", year };
  const month = get("month") ?? "";
  if (month) return { kind: "month", month };
  return ALL;
}

/** The params this filter should put in the URL, and the ones it should remove. */
export function toParams(f: DateFilter): Record<string, string> {
  switch (f.kind) {
    case "year": return f.year ? { year: f.year } : {};
    case "month": return f.month ? { month: f.month } : {};
    case "between": {
      const out: Record<string, string> = {};
      if (f.from) out.from = f.from;
      if (f.to) out.to = f.to;
      return out;
    }
    case "all": return {};
  }
}

/** Every param this filter owns, so switching kinds clears the others. */
export const PARAM_KEYS = ["year", "month", "from", "to"] as const;
