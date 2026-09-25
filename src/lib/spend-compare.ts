import type { DB, ISODate, MonthKey } from "../types.js";
import { addDays, addMonths, daysInMonth, monthEnd, monthOf, monthStart, parseISO, today } from "./date.js";
import { bucketOf } from "./buckets.js";
import { movingCategoryIds, mutedAccountIds } from "./select.js";
import { spendByDay } from "./dashboard.js";

/**
 * Spending so far against the same stretch of some earlier period.
 *
 * One chart, five questions. The shape is always the same - a running total
 * climbing left to right, with the period it is being judged against drawn
 * behind it - and only the stretch and the thing being compared to change.
 *
 * Every one of them is like for like. Comparing three weeks of this month
 * against the whole of last month is how a dashboard tells you every month
 * that you are doing well, right up to the last day, when it stops.
 */
export type CompareMode = "week" | "month" | "year-ago" | "average" | "year";

export const COMPARE_MODES: { value: CompareMode; label: string }[] = [
  { value: "week", label: "This week vs. last week" },
  { value: "month", label: "This month vs. last month" },
  { value: "year-ago", label: "This month vs. last year" },
  { value: "average", label: "This month vs. average month" },
  { value: "year", label: "This year vs. last year" },
];

export const DEFAULT_MODE: CompareMode = "month";

/** Anything that is not one of the five is the default rather than a crash. */
export const readMode = (raw: string | null | undefined): CompareMode =>
  (COMPARE_MODES.some((m) => m.value === raw) ? (raw as CompareMode) : DEFAULT_MODE);

/** How many months back "an average month" averages over. */
export const AVERAGE_OVER = 12;

export interface Comparison {
  mode: CompareMode;
  /** What one step along the x axis is. */
  unit: "day" | "month";
  /** How many steps the axis runs to, so both runs are drawn to one scale. */
  span: number;
  /** [step, running total] for the period being looked at. */
  current: [number, number][];
  /** The same, for whatever it is being judged against. */
  previous: [number, number][];
  label: string;
  priorLabel: string;
  /** What the current run has reached. */
  spent: number;
  /**
   * What the earlier run had reached at the same step.
   *
   * The number the headline compares against, and the whole point of drawing
   * both: the earlier period's final total is not a fair thing to be half way
   * through.
   */
  priorSoFar: number;
  /** What to write under a tick, given its step. */
  tickLabel: (step: number) => string;
}

/** A running total from a day-keyed map, over a list of dates. */
function runUp(daily: Map<ISODate, number>, dates: readonly ISODate[]): number[] {
  let running = 0;
  return dates.map((d) => {
    running += daily.get(d) ?? 0;
    return running;
  });
}

/** Every date from `from` to `to`, inclusive. */
function days(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Every month key from `from` to `to`, inclusive. */
function months(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

const pairs = (totals: readonly number[]): [number, number][] =>
  totals.map((total, i) => [i + 1, total]);

const SHORT_DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function compareSpending(db: DB, mode: CompareMode, now: ISODate = today()): Comparison {
  const muted = mutedAccountIds(db);
  // Worked out once and handed to every run below: the two sides of a
  // comparison have to count the same transactions the same way.
  const moving = movingCategoryIds(db);
  const spentIn = (from: ISODate, to: ISODate) => spendByDay(db, from, to, muted, moving);

  if (mode === "week") {
    const start = bucketOf(now, "week") as ISODate;
    const before = addDays(start, -7);
    const thisWeek = days(start, addDays(start, 6));
    const lastWeek = days(before, addDays(before, 6));
    // Only as far as today: the rest of the week has not happened.
    const shown = thisWeek.filter((d) => d <= now);
    const cur = runUp(spentIn(start, addDays(start, 6)), shown);
    const prior = runUp(spentIn(before, addDays(before, 6)), lastWeek);
    return {
      mode, unit: "day", span: 7,
      current: pairs(cur),
      previous: pairs(prior),
      label: "This week", priorLabel: "Last week",
      spent: cur[cur.length - 1] ?? 0,
      priorSoFar: prior[cur.length - 1] ?? prior[prior.length - 1] ?? 0,
      tickLabel: (step) => SHORT_DAY[parseISO(thisWeek[step - 1] ?? start).getDay()] ?? `Day ${step}`,
    };
  }

  if (mode === "year") {
    const year = Number(now.slice(0, 4));
    const run = (y: number, upTo: ISODate | null) => {
      const all = months(`${y}-01` as MonthKey, `${y}-12` as MonthKey);
      const daily = spentIn(monthStart(all[0]!), upTo ?? monthEnd(all[11]!));
      const byMonth = new Map<MonthKey, number>();
      for (const [date, amount] of daily) {
        const m = monthOf(date);
        byMonth.set(m, (byMonth.get(m) ?? 0) + amount);
      }
      // Only as far as the month in hand: the rest of this year has not
      // happened, and drawing it as a flat line to December would read as
      // eleven months of spending nothing.
      const shown = upTo ? all.filter((m) => m <= monthOf(upTo)) : all;
      let running = 0;
      return shown.map((m) => {
        running += byMonth.get(m) ?? 0;
        return running;
      });
    };
    const cur = run(year, now);
    const prior = run(year - 1, null);
    return {
      mode, unit: "month", span: 12,
      current: pairs(cur),
      previous: pairs(prior),
      label: "This year", priorLabel: "Last year",
      spent: cur[cur.length - 1] ?? 0,
      priorSoFar: prior[cur.length - 1] ?? prior[prior.length - 1] ?? 0,
      tickLabel: (step) => SHORT_MONTH[step - 1] ?? `Month ${step}`,
    };
  }

  // The three that run over a month.
  const month = monthOf(now);
  const shownDays = days(monthStart(month), now);
  const cur = runUp(spentIn(monthStart(month), monthEnd(month)), shownDays);

  /** One whole month, as a running total per day. */
  const wholeMonth = (m: MonthKey): number[] =>
    runUp(spentIn(monthStart(m), monthEnd(m)), days(monthStart(m), monthEnd(m)));

  let prior: number[];
  let priorLabel: string;
  let span: number;

  if (mode === "average") {
    // Only months the document was actually keeping: a ledger that starts in
    // June averaged over a year is seven months of nothing pulling the line
    // down, and an average that says spending is half what it is reads as
    // reassurance rather than as a gap in the data.
    const began = db.transactions.reduce<ISODate | null>(
      (first, t) => (first === null || t.date < first ? t.date : first), null);
    const earlier = months(addMonths(month, -AVERAGE_OVER), addMonths(month, -1))
      .filter((m) => began === null || m >= monthOf(began));
    const runs = earlier.map(wholeMonth);
    span = Math.max(daysInMonth(month), ...runs.map((r) => r.length), 1);
    // Averaged day by day. A month shorter than the longest keeps its final
    // total from its last day onwards rather than dropping out of the mean:
    // February stops on the 28th, it does not stop spending.
    prior = runs.length
      ? Array.from({ length: span }, (_, i) =>
        Math.round(runs.reduce((sum, r) => sum + (r[i] ?? r[r.length - 1] ?? 0), 0) / runs.length))
      : [];
    priorLabel = `Average of ${runs.length} month${runs.length === 1 ? "" : "s"}`;
  } else {
    const other = mode === "year-ago" ? addMonths(month, -12) : addMonths(month, -1);
    prior = wholeMonth(other);
    span = Math.max(daysInMonth(month), daysInMonth(other));
    priorLabel = mode === "year-ago"
      ? parseISO(monthStart(other)).toLocaleDateString("en-US", { month: "long", year: "numeric" })
      : "Last month";
  }

  return {
    mode, unit: "day", span,
    current: pairs(cur),
    previous: pairs(prior),
    label: "This month", priorLabel,
    spent: cur[cur.length - 1] ?? 0,
    priorSoFar: prior[cur.length - 1] ?? prior[prior.length - 1] ?? 0,
    tickLabel: (step) => `Day ${step}`,
  };
}
