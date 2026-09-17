import type { DB, ID, ISODate, MonthKey } from "../types.js";
import { monthEnd, monthRange, today } from "./date.js";
import {
  categoryKind, categoryTotals, counts, lines, merchantIndex, merchantKey,
  mutedAccountIds, netWorthSplitAt,
} from "./select.js";

/**
 * The year, told back to you.
 *
 * Every figure here can be got at from somewhere else in the app. The point is
 * not the arithmetic, it is that nobody goes and does it. A year is the unit
 * people actually think in about money, and until it is laid out in one place
 * the question "was this year better than last?" has no answer anybody can
 * hold in their head.
 *
 * Nothing is congratulated and nothing is scolded. A year where spending rose
 * says spending rose. What that means is not something the document knows.
 */

/** How many of each list is worth reading. Past this it is a ledger. */
export const TOP_N = 8;

export interface YearTotals {
  income: number;
  spending: number;
  saved: number;
  /** Saved as a share of income, or null when nothing came in. */
  rate: number | null;
}

export interface MonthPoint { month: MonthKey; income: number; spending: number; net: number }

export interface CategoryLine {
  id: ID;
  name: string;
  total: number;
  /** Share of the year's spending, in percent. */
  share: number;
  /** The same category last year, and the change. Null when there is no last year. */
  last: number | null;
  delta: number | null;
}

export interface MerchantLine { name: string; total: number; count: number }

export interface YearReview {
  year: number;
  from: ISODate;
  to: ISODate;
  /** The last day counted: the end of the year, or today if it is still running. */
  through: ISODate;
  complete: boolean;
  days: number;
  totals: YearTotals;
  /** The year before, measured the same way, or null when there is nothing to compare. */
  last: YearTotals | null;
  months: MonthPoint[];
  /** The month that put the most away, and the one that put the least. */
  best: MonthPoint | null;
  worst: MonthPoint | null;
  categories: CategoryLine[];
  merchants: MerchantLine[];
  /** Merchants that appear this year and never before. */
  firstTime: string[];
  /** Transactions counted, and what the spending comes to a day. */
  count: number;
  perDay: number;
  /** Where net worth started and finished, and what was paid off debt. */
  netWorth: { start: number; end: number; change: number };
  debt: { start: number; end: number; paid: number };
}

const dayCount = (from: ISODate, to: ISODate): number =>
  Math.floor((Date.parse(to) - Date.parse(from)) / 86400000) + 1;

/**
 * Income, spending and what was left, over a window.
 *
 * Day by day rather than month by month. A year still running ends on today,
 * and rolling up whole months would hand September's last fortnight to a total
 * labelled "so far" and then compare it against a full September last year.
 */
export function totalsBetween(db: DB, from: ISODate, to: ISODate): YearTotals {
  const kind = new Map(db.categories.map((c) => [c.id, categoryKind(db, c.id)]));
  const muted = mutedAccountIds(db);
  let income = 0;
  let spending = 0;
  for (const t of db.transactions) {
    if (!counts(t, muted) || t.date < from || t.date > to) continue;
    for (const l of lines(t)) {
      if (kind.get(l.categoryId) === "transfer") continue;
      if (l.amount >= 0) income += l.amount;
      else spending += -l.amount;
    }
  }
  const saved = income - spending;
  return { income, spending, saved, rate: income > 0 ? Math.round((saved / income) * 1000) / 10 : null };
}

/** Years the document has transactions in, most recent first. */
export function reviewYears(db: DB): number[] {
  const years = new Set<number>();
  for (const t of db.transactions) years.add(Number(t.date.slice(0, 4)));
  return [...years].filter(Number.isFinite).sort((a, b) => b - a);
}

export function yearReview(db: DB, year: number, now: ISODate = today()): YearReview {
  const from: ISODate = `${year}-01-01`;
  const to: ISODate = `${year}-12-31`;
  const through: ISODate = now < to ? now : to;
  const complete = now > to;

  const totals = totalsBetween(db, from, through);

  // Measured over the same stretch of the calendar, not the whole of it: in
  // September, "last year" meaning twelve months against this year's nine
  // would say spending fell every single time.
  const prior: ISODate = `${year - 1}-01-01`;
  // The 29th of February has no answer in the year before it, so it takes the
  // 28th rather than a date that does not exist.
  const sameDay = through.slice(4) === "-02-29" ? "-02-28" : through.slice(4);
  const priorThrough: ISODate = complete ? `${year - 1}-12-31` : `${year - 1}${sameDay}`;
  const hasLast = db.transactions.some((t) => t.date >= prior && t.date <= priorThrough);
  const last = hasLast ? totalsBetween(db, prior, priorThrough) : null;

  // Bounded by `through` rather than rolled up whole months. The cash flow
  // chart elsewhere draws calendar months and is right to; here the current
  // month is half over, and a bar that quietly included a payday dated to the
  // end of it would say the month was fine three weeks before it was.
  const kind = new Map(db.categories.map((c) => [c.id, categoryKind(db, c.id)]));
  const muted = mutedAccountIds(db);
  const byMonth = new Map<MonthKey, { income: number; spending: number }>(
    monthRange(`${year}-01`, `${year}-12`).map((m) => [m, { income: 0, spending: 0 }]),
  );
  const spendByCat = categoryTotals(db, from, through, "expense");
  const lastByCat = new Map(
    categoryTotals(db, prior, priorThrough, "expense").map((c) => [c.categoryId, c.total]),
  );
  const categories: CategoryLine[] = spendByCat.slice(0, TOP_N).map((c) => {
    const before = hasLast ? lastByCat.get(c.categoryId) ?? 0 : null;
    return {
      id: c.categoryId,
      name: c.category.name,
      total: c.total,
      share: totals.spending > 0 ? Math.round((c.total / totals.spending) * 1000) / 10 : 0,
      last: before,
      delta: before === null ? null : c.total - before,
    };
  });

  // By merchant rather than by spelling: "Sushi Yasu" and "sushi yasu" are one
  // restaurant, and splitting them would keep both out of a top eight either
  // of them belonged in.
  const names = merchantIndex(db);
  const spend = new Map<string, { total: number; count: number }>();
  const seenBefore = new Set<string>();
  const seenNow = new Set<string>();
  let count = 0;

  for (const t of db.transactions) {
    if (!counts(t, muted)) continue;
    const key = merchantKey(t.merchant);
    if (t.date < from) { seenBefore.add(key); continue; }
    if (t.date > through) continue;
    count++;

    const month = byMonth.get(t.date.slice(0, 7) as MonthKey);
    if (month) {
      for (const l of lines(t)) {
        if (kind.get(l.categoryId) === "transfer") continue;
        if (l.amount >= 0) month.income += l.amount;
        else month.spending += -l.amount;
      }
    }

    if (t.amount >= 0 || kind.get(t.categoryId) === "transfer") continue;
    seenNow.add(key);
    const row = spend.get(key) ?? { total: 0, count: 0 };
    row.total += -t.amount;
    row.count++;
    spend.set(key, row);
  }

  const merchants: MerchantLine[] = [...spend.entries()]
    .map(([key, row]) => ({ name: names.get(key)?.name ?? key, total: row.total, count: row.count }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, TOP_N);

  const firstTime = [...seenNow]
    .filter((k) => !seenBefore.has(k))
    .map((k) => names.get(k)?.name ?? k)
    .sort();

  const months: MonthPoint[] = [...byMonth.entries()]
    .map(([month, m]) => ({ month, income: m.income, spending: m.spending, net: m.income - m.spending }));
  // Only months that have finished. An unrun December is not the thriftiest
  // month of the year, and neither is the half of September that has happened
  // so far: both would win on being short rather than on anything anybody did.
  const run = months.filter((p) => monthEnd(p.month) <= through);
  const best = run.length ? run.reduce((a, b) => (b.net > a.net ? b : a)) : null;
  const worst = run.length ? run.reduce((a, b) => (b.net < a.net ? b : a)) : null;

  const startWorth = netWorthSplitAt(db, from);
  const endWorth = netWorthSplitAt(db, through);
  const days = Math.max(1, dayCount(from, through));

  return {
    year, from, to, through, complete, days,
    totals, last, months, best, worst, categories, merchants, firstTime,
    count,
    perDay: Math.round(totals.spending / days),
    netWorth: { start: startWorth.net, end: endWorth.net, change: endWorth.net - startWorth.net },
    // Liabilities are held negative, so what was paid off is the rise in that
    // figure. Borrowing more makes it negative, which is the truthful answer.
    debt: {
      start: startWorth.liabilities,
      end: endWorth.liabilities,
      paid: endWorth.liabilities - startWorth.liabilities,
    },
  };
}
