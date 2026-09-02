import type { Account, Category, DB, ISODate, MonthKey, Recurring, Transaction } from "../types";
import { addMonths, diffMonths, monthEnd, monthOf, addDays, parseISO, thisMonth, today, toISO } from "./date";

/* ── lookups ──────────────────────────────────────────────────────────── */

export const byId = <T extends { id: string }>(xs: T[]): Map<string, T> => new Map(xs.map((x) => [x.id, x]));

export function categoryKind(db: DB, categoryId: string): "income" | "expense" | "transfer" {
  const cat = db.categories.find((c) => c.id === categoryId);
  if (!cat) return "expense";
  return db.groups.find((g) => g.id === cat.groupId)?.kind ?? "expense";
}

/** A split transaction contributes through its splits; everything else through itself. */
export function lines(t: Transaction): { categoryId: string; amount: number }[] {
  if (t.splits && t.splits.length) return t.splits.map((s) => ({ categoryId: s.categoryId, amount: s.amount }));
  return [{ categoryId: t.categoryId, amount: t.amount }];
}

export const isAsset = (a: Account): boolean =>
  !["credit", "loan", "mortgage", "other_liability"].includes(a.type);

export const ACCOUNT_GROUPS: { key: string; label: string; types: Account["type"][] }[] = [
  { key: "cash", label: "Cash", types: ["checking", "savings"] },
  { key: "credit", label: "Credit Cards", types: ["credit"] },
  { key: "investments", label: "Investments", types: ["investment", "crypto"] },
  { key: "retirement", label: "Retirement", types: ["retirement"] },
  { key: "property", label: "Property", types: ["real_estate", "other_asset"] },
  { key: "vehicles", label: "Vehicles", types: ["vehicle"] },
  { key: "loans", label: "Loans", types: ["loan", "mortgage", "other_liability"] },
];

export const ACCOUNT_TYPE_LABEL: Record<Account["type"], string> = {
  checking: "Checking", savings: "Savings", credit: "Credit Card", investment: "Brokerage",
  retirement: "Retirement", loan: "Loan", mortgage: "Mortgage", real_estate: "Real Estate",
  vehicle: "Vehicle", crypto: "Crypto", other_asset: "Other Asset", other_liability: "Other Liability",
};

/* ── balances & net worth ─────────────────────────────────────────────── */

/** Latest snapshot at or before `date`; falls back to the earliest known. */
export function balanceAt(account: Account, date: ISODate): number {
  let out: number | undefined;
  for (const h of account.history) {
    if (h.date <= date) out = h.balance;
    else break;
  }
  if (out !== undefined) return out;
  return account.history.length ? 0 : account.balance;
}

export interface NetWorthPoint { month: MonthKey; assets: number; liabilities: number; net: number }

export function netWorthSeries(db: DB, months: MonthKey[]): NetWorthPoint[] {
  const live = db.accounts.filter((a) => a.includeInNetWorth && !a.hidden);
  const now = today();
  return months.map((m) => {
    const at = monthEnd(m) > now ? now : monthEnd(m);
    let assets = 0;
    let liabilities = 0;
    for (const a of live) {
      const b = balanceAt(a, at);
      if (b >= 0) assets += b;
      else liabilities += b;
    }
    return { month: m, assets, liabilities, net: assets + liabilities };
  });
}

/** Net worth as of a given day, from each account's forward-filled snapshots. */
export function netWorthAt(db: DB, date: ISODate): number {
  let total = 0;
  for (const a of db.accounts) {
    if (!a.includeInNetWorth || a.hidden) continue;
    total += balanceAt(a, date);
  }
  return total;
}

/**
 * Assets, liabilities and net on a given day.
 *
 * Split by each balance's sign *on that day* rather than today's: a card paid
 * off, or an account overdrawn, belonged to the other side back then, and
 * classifying it by its current sign would misreport the history.
 */
export function netWorthSplitAt(db: DB, date: ISODate): { assets: number; liabilities: number; net: number } {
  let assets = 0;
  let liabilities = 0;
  for (const a of db.accounts) {
    if (!a.includeInNetWorth || a.hidden) continue;
    const balance = balanceAt(a, date);
    if (balance >= 0) assets += balance;
    else liabilities += balance;
  }
  return { assets, liabilities, net: assets + liabilities };
}

/** Summed balance of several accounts on each of the given days. */
export function aggregateSeries(accounts: Account[], dates: ISODate[]): number[] {
  return dates.map((d) => accounts.reduce((sum, a) => sum + balanceAt(a, d), 0));
}

/**
 * Colours a series by whether it improved, not by its sign.
 *
 * Balances are stored signed, so a loan paid down moves from -30,000 toward
 * zero — an increase, and good news, exactly as a rising asset is. Both add to
 * net worth, so both are green.
 */
export function trendTone(values: number[]): string {
  if (values.length < 2) return "--muted";
  const delta = values[values.length - 1] - values[0];
  if (Math.abs(delta) < 100) return "--muted";
  return delta > 0 ? "--pos" : "--neg";
}

/** Earliest snapshot across the given accounts, if any. */
export function earliestHistoryDate(accounts: Account[]): ISODate | undefined {
  let earliest: ISODate | undefined;
  for (const a of accounts) {
    const first = a.history[0]?.date;
    if (first && (!earliest || first < earliest)) earliest = first;
  }
  return earliest;
}

export function netWorthNow(db: DB): { assets: number; liabilities: number; net: number } {
  let assets = 0;
  let liabilities = 0;
  for (const a of db.accounts) {
    if (!a.includeInNetWorth || a.hidden) continue;
    if (a.balance >= 0) assets += a.balance;
    else liabilities += a.balance;
  }
  return { assets, liabilities, net: assets + liabilities };
}

/**
 * Transactions an account has been told to keep out of the figures.
 *
 * Set per account rather than per transaction, so turning it on excludes the
 * history as well as anything that arrives later — which is the point of it.
 */
export function mutedAccountIds(db: DB): Set<string> {
  return new Set(db.accounts.filter((a) => a.hideTransactions).map((a) => a.id));
}

/** Whether a transaction should count towards budgets, cash flow and reports. */
export function counts(t: Transaction, muted: Set<string>): boolean {
  return !t.hideFromReports && !muted.has(t.accountId);
}

/**
 * The categories whose money is spending, as opposed to money moving.
 *
 * Two separate things put a category outside a budget: the per-category
 * "Exclude from budget" toggle, and belonging to a group of kind transfer. They
 * usually agree — a category made under Transfers gets the flag — but a
 * category dragged into that group later would not, so both are checked.
 *
 * Why it matters beyond the budget page: a credit card payment is the same
 * money twice. It leaves checking as the payment and it already left as the
 * groceries bought on the card, so anything that adds up a day or a month
 * double-counts it, and a payday shows as a wash.
 *
 * A set rather than a predicate, because the callers ask once per line across
 * every transaction on screen.
 */
export function budgetedCategoryIds(db: DB): Set<string> {
  const transfers = new Set(db.groups.filter((g) => g.kind === "transfer").map((g) => g.id));
  return new Set(
    db.categories
      .filter((c) => !c.excludeFromBudget && !transfers.has(c.groupId))
      .map((c) => c.id),
  );
}

export interface BudgetedSum {
  /** What the transactions come to, counting only budgeted categories. */
  total: number;
  /** What was left out, so a caller can say so rather than looking wrong. */
  excluded: number;
  /**
   * How many lines were left out.
   *
   * Not derivable from `excluded`, which is what makes it worth carrying: a
   * transfer is two rows, the money leaving one account and arriving in the
   * other, so a day holding both nets to zero having excluded a great deal.
   * A caller asking "was anything left out" has to ask this one.
   */
  excludedCount: number;
  /** The categories it was left out of, named. */
  excludedNames: string[];
}

/**
 * Adds up transactions the way the budget would.
 *
 * Split transactions contribute split by split, so one that is half a card
 * payment and half a purchase counts for the half that is spending.
 */
export function budgetedSum(
  db: DB,
  txns: Transaction[],
  budgeted: Set<string> = budgetedCategoryIds(db),
): BudgetedSum {
  const names = byId(db.categories);
  const left = new Map<string, string>();
  let total = 0;
  let excluded = 0;
  let excludedCount = 0;
  for (const t of txns) {
    for (const l of lines(t)) {
      if (budgeted.has(l.categoryId)) { total += l.amount; continue; }
      excluded += l.amount;
      excludedCount++;
      const cat = names.get(l.categoryId);
      if (cat) left.set(cat.id, cat.name);
    }
  }
  return { total, excluded, excludedCount, excludedNames: [...left.values()].sort() };
}

/* ── cash flow ────────────────────────────────────────────────────────── */

export interface FlowPoint { month: MonthKey; income: number; expense: number; net: number }

export function cashFlowSeries(db: DB, months: MonthKey[]): FlowPoint[] {
  const kind = new Map(db.categories.map((c) => [c.id, categoryKind(db, c.id)]));
  const acc = new Map(months.map((m) => [m, { income: 0, expense: 0 }]));
  const muted = mutedAccountIds(db);
  for (const t of db.transactions) {
    if (!counts(t, muted)) continue;
    const bucket = acc.get(monthOf(t.date));
    if (!bucket) continue;
    for (const l of lines(t)) {
      const k = kind.get(l.categoryId);
      if (k === "transfer") continue;
      if (l.amount >= 0) bucket.income += l.amount;
      else bucket.expense += -l.amount;
    }
  }
  return months.map((m) => {
    const b = acc.get(m)!;
    return { month: m, income: b.income, expense: b.expense, net: b.income - b.expense };
  });
}

export interface CatTotal { categoryId: string; category: Category; total: number; count: number }

export function categoryTotals(
  db: DB, from: ISODate, to: ISODate, kind: "income" | "expense" | "all" = "expense",
): CatTotal[] {
  const cats = byId(db.categories);
  const tally = new Map<string, { total: number; count: number }>();
  const muted = mutedAccountIds(db);
  for (const t of db.transactions) {
    if (!counts(t, muted) || t.date < from || t.date > to) continue;
    for (const l of lines(t)) {
      const k = categoryKind(db, l.categoryId);
      if (k === "transfer") continue;
      if (kind === "expense" && l.amount >= 0) continue;
      if (kind === "income" && l.amount < 0) continue;
      const cur = tally.get(l.categoryId) ?? { total: 0, count: 0 };
      cur.total += Math.abs(l.amount);
      cur.count += 1;
      tally.set(l.categoryId, cur);
    }
  }
  return [...tally.entries()]
    .filter(([id]) => cats.has(id))
    .map(([id, v]) => ({ categoryId: id, category: cats.get(id)!, total: v.total, count: v.count }))
    .sort((a, b) => b.total - a.total);
}

export function merchantTotals(db: DB, from: ISODate, to: ISODate, limit = 10) {
  const tally = new Map<string, { total: number; count: number }>();
  const muted = mutedAccountIds(db);
  for (const t of db.transactions) {
    if (!counts(t, muted) || t.date < from || t.date > to || t.amount >= 0) continue;
    if (categoryKind(db, t.categoryId) === "transfer") continue;
    const cur = tally.get(t.merchant) ?? { total: 0, count: 0 };
    cur.total += -t.amount;
    cur.count += 1;
    tally.set(t.merchant, cur);
  }
  return [...tally.entries()]
    .map(([merchant, v]) => ({ merchant, ...v }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/* ── budget ───────────────────────────────────────────────────────────── */

export interface BudgetRow {
  category: Category;
  planned: number;
  actual: number;
  remaining: number;
  rollover: number;
  kind: "income" | "expense" | "transfer";
}
export interface BudgetGroupRow {
  group: { id: string; name: string; kind: string };
  rows: BudgetRow[];
  planned: number;
  actual: number;
  remaining: number;
}

/**
 * What a category is budgeted for in a month: an explicit entry if there is
 * one, otherwise the standing default once its start month is reached.
 */
export function plannedFor(db: DB, month: MonthKey, categoryId: string): number {
  const explicit = db.budgets[month]?.[categoryId];
  if (explicit !== undefined) return explicit;
  const fallback = db.budgetDefaults?.[categoryId];
  if (fallback && month >= fallback.from) return fallback.amount;
  return 0;
}

/**
 * Sets a standing amount from `month` onwards, dropping later explicit entries
 * that would otherwise mask it. Earlier months are untouched.
 */
export function applyForward(db: DB, month: MonthKey, categoryId: string, amount: number): DB {
  const budgets: DB["budgets"] = {};
  for (const [m, row] of Object.entries(db.budgets)) {
    if (m < month) { budgets[m] = row; continue; }
    const { [categoryId]: _dropped, ...rest } = row;
    budgets[m] = rest;
  }
  return {
    ...db,
    budgets,
    budgetDefaults: { ...(db.budgetDefaults ?? {}), [categoryId]: { amount, from: month } },
  };
}

/** Actual totals for one category over the given months, oldest first. */
export function categoryHistory(db: DB, categoryId: string, months: MonthKey[]): { month: MonthKey; actual: number }[] {
  const totals = new Map<MonthKey, number>(months.map((m) => [m, 0]));
  const muted = mutedAccountIds(db);
  for (const t of db.transactions) {
    if (!counts(t, muted)) continue;
    const month = monthOf(t.date);
    if (!totals.has(month)) continue;
    for (const l of lines(t)) {
      if (l.categoryId !== categoryId) continue;
      totals.set(month, (totals.get(month) ?? 0) + Math.abs(l.amount));
    }
  }
  return months.map((month) => ({ month, actual: totals.get(month) ?? 0 }));
}

/**
 * Mean spend across the window, counting months with no activity as zero —
 * a category used twice a year averages low, which is the useful answer when
 * setting a monthly number.
 */
export function categoryAverage(history: { actual: number }[]): number {
  if (!history.length) return 0;
  return Math.round(history.reduce((sum, h) => sum + h.actual, 0) / history.length);
}

export function actualsFor(db: DB, month: MonthKey): Map<string, number> {
  const out = new Map<string, number>();
  const muted = mutedAccountIds(db);
  for (const t of db.transactions) {
    if (!counts(t, muted) || monthOf(t.date) !== month) continue;
    for (const l of lines(t)) out.set(l.categoryId, (out.get(l.categoryId) ?? 0) + Math.abs(l.amount));
  }
  return out;
}

/**
 * Accumulated under/overspend carried into `month`, for categories with rollover on.
 * Walks forward from the first budgeted month so a long history stays consistent.
 */
export function rolloverFor(db: DB, month: MonthKey, categoryId: string): number {
  const cat = db.categories.find((c) => c.id === categoryId);
  if (!cat?.rollover) return 0;
  const withDefault = db.budgetDefaults?.[categoryId]?.from;
  const budgeted = [...new Set([...Object.keys(db.budgets), ...(withDefault ? [withDefault] : [])])]
    .filter((m) => m < month)
    .sort();
  if (!budgeted.length) return 0;
  let carry = 0;
  for (const m of budgeted.slice(-24)) {
    const planned = plannedFor(db, m, categoryId);
    if (!planned && carry === 0) continue;
    const actual = actualsFor(db, m).get(categoryId) ?? 0;
    carry = Math.max(0, carry + planned - actual);
  }
  return carry;
}

export function budgetTable(db: DB, month: MonthKey): BudgetGroupRow[] {
  const actuals = actualsFor(db, month);
  const budgeted = budgetedCategoryIds(db);
  const out: BudgetGroupRow[] = [];
  for (const g of [...db.groups].sort((a, b) => a.order - b.order)) {
    const rows: BudgetRow[] = [];
    for (const c of db.categories.filter((c) => c.groupId === g.id && !c.archived).sort((a, b) => a.order - b.order)) {
      // One test instead of the two this used to make — a transfer group and
      // an excluded category — so that what the transaction list leaves out of
      // a day total is exactly what this page declines to budget.
      if (!budgeted.has(c.id)) continue;
      const p = plannedFor(db, month, c.id);
      const a = actuals.get(c.id) ?? 0;
      // Every category appears in every month. Hiding the quiet ones meant a
      // future month came up nearly blank and had to be rebuilt by hand, and
      // it made a category emptied by a move look deleted.
      const roll = rolloverFor(db, month, c.id);
      rows.push({ category: c, planned: p, actual: a, remaining: p + roll - a, rollover: roll, kind: g.kind });
    }
    if (!rows.length) continue;
    out.push({
      group: g,
      rows,
      planned: rows.reduce((s, r) => s + r.planned, 0),
      actual: rows.reduce((s, r) => s + r.actual, 0),
      remaining: rows.reduce((s, r) => s + r.remaining, 0),
    });
  }
  return out;
}

/**
 * How what's left in a category reads: money in hand, overspent, or neither.
 * Shared so the group total and the row cell can never disagree.
 */
export function remainingTone(remaining: number): "pos" | "neg" | "flat" {
  if (remaining > 0) return "pos";
  if (remaining < 0) return "neg";
  return "flat";
}

/**
 * What share of a month's available money has been spent. Null when nothing was
 * available, because a percentage of zero says nothing useful.
 */
export function spentShare(available: number, actual: number): number | null {
  if (available <= 0) return null;
  return Math.round((actual / available) * 100);
}

export function budgetSummary(db: DB, month: MonthKey) {
  const table = budgetTable(db, month);
  const income = table.filter((g) => g.group.kind === "income");
  const expense = table.filter((g) => g.group.kind === "expense");
  const plannedIncome = income.reduce((s, g) => s + g.planned, 0);
  const actualIncome = income.reduce((s, g) => s + g.actual, 0);
  const plannedExpense = expense.reduce((s, g) => s + g.planned, 0);
  const actualExpense = expense.reduce((s, g) => s + g.actual, 0);
  return {
    table, income, expense,
    plannedIncome, actualIncome, plannedExpense, actualExpense,
    leftToBudget: plannedIncome - plannedExpense,
    plannedSavings: plannedIncome - plannedExpense,
    actualSavings: actualIncome - actualExpense,
  };
}

/* ── recurring detection ──────────────────────────────────────────────── */

const CADENCE_DAYS: [Recurring["cadence"], number][] = [
  ["weekly", 7], ["biweekly", 14], ["monthly", 30.4], ["quarterly", 91.3], ["semiannual", 182.6], ["yearly", 365],
];

/**
 * Finds merchants billed on a steady interval. Requires three or more hits and
 * a gap that stays within ~18% of a known cadence.
 */
export function detectRecurring(db: DB): Recurring[] {
  const cutoff = addDays(today(), -400);
  const groups = new Map<string, Transaction[]>();
  const muted = mutedAccountIds(db);
  for (const t of db.transactions) {
    if (!counts(t, muted) || t.date < cutoff || categoryKind(db, t.categoryId) === "transfer") continue;
    const key = t.merchant.toLowerCase().trim();
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }
  const out: Recurring[] = [];
  for (const [, txns] of groups) {
    if (txns.length < 3) continue;
    const sorted = [...txns].sort((a, b) => (a.date < b.date ? -1 : 1));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((parseISO(sorted[i].date).getTime() - parseISO(sorted[i - 1].date).getTime()) / 86400000);
    }
    const median = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const match = CADENCE_DAYS.find(([, d]) => Math.abs(median - d) / d < 0.18);
    if (!match) continue;

    // The interval has to be steady, not just right on average. Groceries land
    // ~5 times a month at random, which averages out near weekly — the spread
    // of the individual gaps is what tells the two apart.
    const tolerance = Math.max(3, median * 0.2);
    const steady = gaps.filter((g) => Math.abs(g - median) <= tolerance).length / gaps.length;
    if (steady < 0.7) continue;

    // Utility bills swing with the season, so only wildly variable amounts are
    // disqualifying here.
    const amounts = sorted.map((t) => Math.abs(t.amount));
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const spread = Math.max(...amounts) - Math.min(...amounts);
    if (avg > 0 && spread / avg > 1.5) continue;

    const last = sorted[sorted.length - 1];
    const [cadence, days] = match;
    let next = toISO(new Date(parseISO(last.date).getTime() + days * 86400000));
    while (next < today()) next = toISO(new Date(parseISO(next).getTime() + days * 86400000));
    out.push({
      id: `rec_${last.merchant.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      merchant: last.merchant,
      categoryId: last.categoryId,
      accountId: last.accountId,
      amount: Math.round(avg) * (last.amount < 0 ? -1 : 1),
      cadence,
      nextDate: next,
      kind: last.amount > 0 ? "income" : avg < 5000 ? "subscription" : "bill",
      detected: true,
    });
  }
  return out.sort((a, b) => (a.nextDate < b.nextDate ? -1 : 1));
}

/** Detected items merged with the user's manual edits and dismissals. */
export function recurringList(db: DB): Recurring[] {
  const manual = new Map(db.recurring.map((r) => [r.id, r]));
  const merged: Recurring[] = [];
  for (const d of detectRecurring(db)) {
    const override = manual.get(d.id);
    if (override?.dismissed) continue;
    merged.push(override ? { ...d, ...override } : d);
    manual.delete(d.id);
  }
  for (const r of manual.values()) if (!r.dismissed) merged.push(r);
  return merged.sort((a, b) => (a.nextDate < b.nextDate ? -1 : 1));
}

export function monthlyRecurringCost(list: Recurring[]): number {
  const per: Record<Recurring["cadence"], number> = {
    weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, quarterly: 1 / 3, semiannual: 1 / 6, yearly: 1 / 12,
  };
  return list.filter((r) => r.amount < 0).reduce((s, r) => s + Math.abs(r.amount) * per[r.cadence], 0);
}

/* ── investments ──────────────────────────────────────────────────────── */

export function holdingValue(h: { quantity: number; price: number }): number {
  return Math.round(h.quantity * h.price);
}
export function holdingCost(h: { quantity: number; costBasis: number }): number {
  return Math.round(h.quantity * h.costBasis);
}

export const ASSET_CLASS_LABEL: Record<string, string> = {
  us_equity: "US Stocks", intl_equity: "International", bond: "Bonds",
  cash: "Cash", crypto: "Crypto", real_estate: "Real Estate", other: "Other",
};

export function portfolioSummary(db: DB) {
  const invAccounts = db.accounts.filter((a) => ["investment", "retirement", "crypto"].includes(a.type) && !a.hidden);
  const holdings = db.holdings.filter((h) => invAccounts.some((a) => a.id === h.accountId));
  const value = holdings.reduce((s, h) => s + holdingValue(h), 0);
  const cost = holdings.reduce((s, h) => s + holdingCost(h), 0);
  const byClass = new Map<string, number>();
  for (const h of holdings) byClass.set(h.assetClass, (byClass.get(h.assetClass) ?? 0) + holdingValue(h));
  const accountsValue = invAccounts.reduce((s, a) => s + a.balance, 0);
  return {
    invAccounts, holdings, value, cost, gain: value - cost,
    gainPct: cost ? ((value - cost) / cost) * 100 : 0,
    byClass: [...byClass.entries()].map(([k, v]) => ({ key: k, label: ASSET_CLASS_LABEL[k] ?? k, value: v })).sort((a, b) => b.value - a.value),
    accountsValue,
  };
}

/* ── goals ────────────────────────────────────────────────────────────── */

export function goalProgress(db: DB, goalId: string): { saved: number; pct: number; monthsLeft: number | null; onTrack: boolean } {
  const g = db.goals.find((x) => x.id === goalId);
  if (!g) return { saved: 0, pct: 0, monthsLeft: null, onTrack: false };
  const linked = g.accountIds.reduce((s, id) => s + (db.accounts.find((a) => a.id === id)?.balance ?? 0), 0);
  const saved = linked + g.startingAmount;
  const pct = g.targetAmount ? Math.min(100, (saved / g.targetAmount) * 100) : 0;
  const monthsLeft = g.targetDate ? Math.max(0, diffMonths(thisMonth(), monthOf(g.targetDate))) : null;
  const needed = monthsLeft && monthsLeft > 0 ? (g.targetAmount - saved) / monthsLeft : 0;
  return { saved, pct, monthsLeft, onTrack: monthsLeft === null ? true : g.monthlyContribution >= needed };
}

/* ── sankey ───────────────────────────────────────────────────────────── */

export interface SankeyNode { id: string; label: string; value: number; color: string; depth: number }
export interface SankeyLink { source: string; target: string; value: number }

/** Income categories → "Cash flow" → expense groups. */
export function sankeyData(db: DB, from: ISODate, to: ISODate): { nodes: SankeyNode[]; links: SankeyLink[] } {
  const incomes = categoryTotals(db, from, to, "income");
  const expenses = categoryTotals(db, from, to, "expense");
  const byGroup = new Map<string, number>();
  for (const e of expenses) byGroup.set(e.category.groupId, (byGroup.get(e.category.groupId) ?? 0) + e.total);

  const totalIn = incomes.reduce((s, i) => s + i.total, 0);
  const totalOut = [...byGroup.values()].reduce((s, v) => s + v, 0);
  const nodes: SankeyNode[] = [{ id: "hub", label: "Cash flow", value: totalIn, color: "--c3", depth: 1 }];
  const links: SankeyLink[] = [];
  for (const i of incomes.slice(0, 6)) {
    nodes.push({ id: `in_${i.categoryId}`, label: i.category.name, value: i.total, color: i.category.color, depth: 0 });
    links.push({ source: `in_${i.categoryId}`, target: "hub", value: i.total });
  }
  // anything under 4% of spending is folded into a single "Other" band so the
  // labels on the right stay legible
  let tail = 0;
  for (const [gid, total] of [...byGroup.entries()].sort((a, b) => b[1] - a[1])) {
    const g = db.groups.find((x) => x.id === gid);
    if (!g) continue;
    if (totalOut > 0 && total / totalOut < 0.04) { tail += total; continue; }
    const color = db.categories.find((c) => c.groupId === gid)?.color ?? "--c1";
    nodes.push({ id: `out_${gid}`, label: g.name, value: total, color, depth: 2 });
    links.push({ source: "hub", target: `out_${gid}`, value: total });
  }
  if (tail > 0) {
    nodes.push({ id: "out_tail", label: "Everything else", value: tail, color: "--c12", depth: 2 });
    links.push({ source: "hub", target: "out_tail", value: tail });
  }
  if (totalIn > totalOut) {
    nodes.push({ id: "out_saved", label: "Saved", value: totalIn - totalOut, color: "--c3", depth: 2 });
    links.push({ source: "hub", target: "out_saved", value: totalIn - totalOut });
  }
  return { nodes, links };
}

/* ── misc ─────────────────────────────────────────────────────────────── */

export function needsReviewCount(db: DB): number {
  return db.transactions.filter((t) => !t.reviewed).length;
}

export function monthOptions(db: DB): MonthKey[] {
  if (!db.transactions.length) return [thisMonth()];
  const dates = db.transactions.map((t) => t.date);
  const min = monthOf(dates.reduce((a, b) => (a < b ? a : b)));
  const max = addMonths(thisMonth(), 1);
  const out: MonthKey[] = [];
  for (let m = min; m <= max; m = addMonths(m, 1)) out.push(m);
  return out.reverse();
}
