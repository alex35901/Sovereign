import type { ISODate, MonthKey } from "../types";
import { addDays, addMonths, diffMonths, monthOf, parseISO, thisMonth, today } from "./date";

export type RangeKey = "1m" | "3m" | "6m" | "ytd" | "1y" | "5y" | "all";

export const RANGES: { value: RangeKey; label: string }[] = [
  { value: "1m", label: "1 month" },
  { value: "3m", label: "3 months" },
  { value: "6m", label: "6 months" },
  { value: "ytd", label: "Year to date" },
  { value: "1y", label: "1 year" },
  { value: "5y", label: "5 years" },
  { value: "all", label: "All time" },
];

const FIXED_MONTHS: Partial<Record<RangeKey, number>> = { "1m": 1, "3m": 3, "6m": 6, "1y": 12, "5y": 60 };

/** Whole months covered by a range — for the month-bucketed screens. */
export function rangeMonths(key: RangeKey, earliest?: MonthKey): number {
  const fixed = FIXED_MONTHS[key];
  if (fixed) return fixed;
  if (key === "ytd") return Number(thisMonth().slice(5, 7));
  // "all": back to the first month there is data for, 24 months if there is none
  if (!earliest) return 24;
  return Math.max(1, diffMonths(earliest, thisMonth()) + 1);
}

/** First day a range covers. */
export function rangeStart(key: RangeKey, earliest?: ISODate): ISODate {
  const end = today();
  if (key === "ytd") return `${end.slice(0, 4)}-01-01`;
  if (key === "all") return earliest ?? `${addMonths(monthOf(end), -23)}-01`;
  const months = FIXED_MONTHS[key] ?? 6;
  return addDays(`${addMonths(monthOf(end), -months)}-${end.slice(8, 10)}`, 0);
}

/**
 * Dates to plot between two days, capped so a five-year view doesn't try to
 * draw two thousand points. Daily for short ranges, thinning out for long ones;
 * the final day is always included so the chart ends on today's value.
 */
export function sampleDates(from: ISODate, to: ISODate, maxPoints = 90): ISODate[] {
  const days = Math.max(1, Math.round((parseISO(to).getTime() - parseISO(from).getTime()) / 86400000) + 1);
  const step = Math.max(1, Math.ceil(days / maxPoints));
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, step)) out.push(d);
  if (out[out.length - 1] !== to) out.push(to);
  return out;
}

/** Short label for a sampled date — day-level for short spans, month for long. */
export function sampleLabel(date: ISODate, spanDays: number): string {
  const d = parseISO(date);
  // "Aug 25" would read as the 25th on a short range and as 2025 on a long
  // one, so the year form is marked
  return spanDays <= 200
    ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : `${d.toLocaleDateString("en-US", { month: "short" })} '${String(d.getFullYear()).slice(2)}`;
}

export const spanDays = (from: ISODate, to: ISODate): number =>
  Math.max(1, Math.round((parseISO(to).getTime() - parseISO(from).getTime()) / 86400000));

