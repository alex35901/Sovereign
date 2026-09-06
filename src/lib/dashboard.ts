import type { DB, ISODate, MonthKey, Recurring } from "../types.js";
import { addMonths, daysInMonth, monthEnd, monthOf, monthStart, today } from "./date.js";
import { mutedAccountIds, counts, recurringList } from "./select.js";

/**
 * The figures the dashboard puts side by side.
 *
 * Kept out of the screen because every one of them is a comparison, and a
 * comparison drawn from two differently-worked-out numbers is worse than no
 * comparison at all: this month's spending against last month's has to count
 * the same transactions the same way on both sides, or the shape of the
 * difference is an artefact of the code rather than of the money.
 */

/* ── spending, this month against last ────────────────────────────────── */

export interface SpendPoint {
  /** Day of the month, 1-based, so the two months line up on the x axis. */
  day: number;
  /** Spent from the first of the month to the end of this day. */
  total: number;
}

export interface SpendPace {
  thisMonth: SpendPoint[];
  lastMonth: SpendPoint[];
  /** Spent so far this month, and over the whole of last. */
  spent: number;
  spentLast: number;
  /** How far through the month today is, 0 to 1. */
  progress: number;
  /** The longer of the two months, which is how wide the chart has to be. */
  days: number;
}

/** Cumulative spending through one month, a point per day. */
function cumulative(db: DB, month: MonthKey, upTo: ISODate | null, muted: Set<string>): SpendPoint[] {
  const from = monthStart(month);
  const to = monthEnd(month);
  const daily = new Map<number, number>();
  for (const t of db.transactions) {
    if (t.date < from || t.date > to) continue;
    if (upTo && t.date > upTo) continue;
    if (!counts(t, muted)) continue;
    // Spending only: a payday landing mid-month would otherwise walk the line
    // backwards and turn "spent so far" into "net so far", which is a
    // different question and the one the budget card answers.
    if (t.amount >= 0) continue;
    const day = Number(t.date.slice(8, 10));
    daily.set(day, (daily.get(day) ?? 0) + -t.amount);
  }

  const last = upTo && monthOf(upTo) === month ? Number(upTo.slice(8, 10)) : daysInMonth(month);
  const out: SpendPoint[] = [];
  let running = 0;
  for (let day = 1; day <= last; day += 1) {
    running += daily.get(day) ?? 0;
    out.push({ day, total: running });
  }
  return out;
}

export function spendPace(db: DB, now: ISODate = today()): SpendPace {
  const month = monthOf(now);
  const previous = addMonths(month, -1);
  const muted = mutedAccountIds(db);
  const thisMonth = cumulative(db, month, now, muted);
  const lastMonth = cumulative(db, previous, null, muted);
  const days = daysInMonth(month);
  return {
    thisMonth,
    lastMonth,
    spent: thisMonth[thisMonth.length - 1]?.total ?? 0,
    spentLast: lastMonth[lastMonth.length - 1]?.total ?? 0,
    progress: monthProgress(month, now),
    days: Math.max(days, daysInMonth(previous)),
  };
}

/**
 * How far through a month a day is, 0 to 1.
 *
 * Counted in whole days elapsed, so the first of the month is not already
 * 1/31 of the way through before anything has happened, and the last day of
 * the month reads as full rather than as one day short of it.
 */
export function monthProgress(month: MonthKey, now: ISODate = today()): number {
  if (monthOf(now) < month) return 0;
  if (monthOf(now) > month) return 1;
  return Number(now.slice(8, 10)) / daysInMonth(month);
}

/* ── what is still to come out ────────────────────────────────────────── */

export interface DueSoon {
  items: Recurring[];
  /** Money still expected to leave before the month is out. */
  remaining: number;
}

/**
 * The recurring charges still ahead of you this month.
 *
 * Only what is left: a subscription that came out on the 3rd is spent money
 * and belongs in the spending figure, not in "remaining due". Outgoings only
 * for the total, because "remaining due" is a bill, and netting an expected
 * paycheque against it would report a number nobody owes.
 */
export function dueSoon(db: DB, now: ISODate = today(), limit = 6): DueSoon {
  const end = monthEnd(monthOf(now));
  const ahead = recurringList(db).filter((r) => r.nextDate >= now);
  return {
    items: ahead.slice(0, limit),
    remaining: ahead
      .filter((r) => r.nextDate <= end && r.amount < 0)
      .reduce((s, r) => s + -r.amount, 0),
  };
}
