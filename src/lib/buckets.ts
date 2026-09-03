import type { ISODate, MonthKey } from "../types.js";
import { addDays, addMonths, monthEnd, monthLabel, monthOf, monthStart, parseISO, toISO } from "./date.js";

/**
 * Chopping a run of dates into the periods a chart draws bars for.
 *
 * Every period is identified by a string that sorts chronologically and says
 * what it is on sight — "2026-08-31" for a week, "2026-Q3" for a quarter — so a
 * key can go in a URL and come back out without a lookup table, and a map of
 * them is already in order.
 *
 * A week is named by its Monday rather than by an ISO week number. Week 1 of a
 * year is a genuinely difficult question with several defensible answers, and
 * none of them are worth asking when the Monday answers it exactly and reads
 * better on an axis.
 */

export type Grain = "day" | "week" | "month" | "quarter" | "year";

export const GRAINS: { value: Grain; label: string }[] = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "quarter", label: "Quarterly" },
  { value: "year", label: "Yearly" },
];

export const isGrain = (v: string): v is Grain => GRAINS.some((g) => g.value === v);

/** The Monday of the week `date` falls in. */
function weekStart(date: ISODate): ISODate {
  const d = parseISO(date);
  // getDay() is 0 on Sunday; shift so Monday is 0 and Sunday closes the week
  // it belongs to rather than opening the next one.
  return addDays(date, -((d.getDay() + 6) % 7));
}

const quarterOf = (date: ISODate): number => Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;

/** Which period a date belongs to. */
export function bucketOf(date: ISODate, grain: Grain): string {
  switch (grain) {
    case "day": return date;
    case "week": return weekStart(date);
    case "month": return date.slice(0, 7);
    case "quarter": return `${date.slice(0, 4)}-Q${quarterOf(date)}`;
    case "year": return date.slice(0, 4);
  }
}

/** The first and last date inside a period, both inclusive. */
export function bucketSpan(key: string, grain: Grain): { from: ISODate; to: ISODate } {
  switch (grain) {
    case "day": return { from: key, to: key };
    case "week": return { from: key, to: addDays(key, 6) };
    case "month": return { from: monthStart(key), to: monthEnd(key) };
    case "quarter": {
      const [y, q] = [key.slice(0, 4), Number(key.slice(6))];
      const first: MonthKey = `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}`;
      return { from: monthStart(first), to: monthEnd(addMonths(first, 2)) };
    }
    case "year": return { from: `${key}-01-01`, to: `${key}-12-31` };
  }
}

/** The next period along, so a caller can walk without knowing the calendar. */
export function nextBucket(key: string, grain: Grain): string {
  const { to } = bucketSpan(key, grain);
  return bucketOf(addDays(to, 1), grain);
}

/** The period before. */
export function prevBucket(key: string, grain: Grain): string {
  const { from } = bucketSpan(key, grain);
  return bucketOf(addDays(from, -1), grain);
}

/**
 * Every period between two dates, oldest first, including empty ones.
 *
 * The gaps matter: a month with no spending is a bar of zero height, and
 * dropping it would put July next to September and quietly redraw the trend.
 */
export function bucketsBetween(from: ISODate, to: ISODate, grain: Grain, cap = 4000): string[] {
  if (from > to) return [];
  const out: string[] = [];
  let key = bucketOf(from, grain);
  const last = bucketOf(to, grain);
  while (out.length < cap) {
    out.push(key);
    if (key >= last) break;
    key = nextBucket(key, grain);
  }
  return out;
}

/**
 * The newest `n` periods ending at `to`, never reaching back before `from`.
 *
 * What a chart wants, and not the same thing as taking the tail of every
 * period in the range: building the whole history first means a daily chart
 * of four years assembles fifteen hundred keys to throw all but sixty away,
 * and any guard against that runs out at the wrong end — it truncates the
 * distant past into place and the chart quietly shows 2025 while claiming to
 * show now. This counts backwards from the present instead.
 */
export function lastBuckets(from: ISODate, to: ISODate, grain: Grain, n: number): string[] {
  if (n < 1 || from > to) return [];
  const floor = bucketOf(from, grain);
  const out = [bucketOf(to, grain)];
  while (out.length < n) {
    const prev = prevBucket(out[0]!, grain);
    if (prev < floor) break;
    out.unshift(prev);
  }
  return out;
}

/** Short enough for an axis. */
export function bucketLabel(key: string, grain: Grain): string {
  switch (grain) {
    case "day": return parseISO(key).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    case "week": return parseISO(key).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    case "month": return monthLabel(key, true).split(" ")[0]!;
    case "quarter": return key.slice(5);
    case "year": return key;
  }
}

/** The heading over the detail: unambiguous, with the year spelled out. */
export function bucketTitle(key: string, grain: Grain): string {
  const { from, to } = bucketSpan(key, grain);
  const full = (d: ISODate) => parseISO(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  switch (grain) {
    case "day": return full(key);
    case "week": return `${full(from)} – ${full(to)}`;
    case "month": return monthLabel(key);
    case "quarter": return `${key.slice(5)} ${key.slice(0, 4)}`;
    case "year": return key;
  }
}

/**
 * The whole months a period touches.
 *
 * Budgets are set by month and nothing smaller, so a day or a week has to
 * report against the month around it rather than against some slice of a plan
 * that was never divided up. A week straddling the turn of a month touches two.
 */
export function monthsIn(key: string, grain: Grain): MonthKey[] {
  const { from, to } = bucketSpan(key, grain);
  const out: MonthKey[] = [];
  for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) out.push(m);
  return out;
}

/** Whether a period is exactly some whole months, so a budget lines up with it. */
export const alignsToMonths = (grain: Grain): boolean =>
  grain === "month" || grain === "quarter" || grain === "year";

/** Same period as today's. */
export const currentBucket = (grain: Grain, now: ISODate = toISO(new Date())): string => bucketOf(now, grain);
