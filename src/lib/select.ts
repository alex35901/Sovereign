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
  { key: "property", label: "Property", types: ["real_estate", "vehicle", "other_asset"] },
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

/* ── cash flow ────────────────────────────────────────────────────────── */

export interface FlowPoint { month: MonthKey; income: number; expense: number; net: number }

export function cashFlowSeries(db: DB, months: MonthKey[]): FlowPoint[] {
  const kind = new Map(db.categories.map((c) => [c.id, categoryKind(db, c.id)]));
  const acc = new Map(months.map((m) => [m, { income: 0, expense: 0 }]));
  for (const t of db.transactions) {
    if (t.hideFromReports) continue;
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
  for (const t of db.transactions) {
    if (t.hideFromReports || t.date < from || t.date > to) continue;
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
  for (const t of db.transactions) {
    if (t.hideFromReports || t.date < from || t.date > to || t.amount >= 0) continue;
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

export function actualsFor(db: DB, month: MonthKey): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of db.transactions) {
    if (t.hideFromReports || monthOf(t.date) !== month) continue;
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
  const budgeted = Object.keys(db.budgets).filter((m) => m < month).sort();
  if (!budgeted.length) return 0;
  let carry = 0;
  for (const m of budgeted.slice(-24)) {
    const planned = db.budgets[m]?.[categoryId] ?? 0;
    if (!planned && carry === 0) continue;
    const actual = actualsFor(db, m).get(categoryId) ?? 0;
    carry = Math.max(0, carry + planned - actual);
  }
  return carry;
}

export function budgetTable(db: DB, month: MonthKey): BudgetGroupRow[] {
  const actuals = actualsFor(db, month);
  const planned = db.budgets[month] ?? {};
  const out: BudgetGroupRow[] = [];
  for (const g of [...db.groups].sort((a, b) => a.order - b.order)) {
    if (g.kind === "transfer") continue;
    const rows: BudgetRow[] = [];
    for (const c of db.categories.filter((c) => c.groupId === g.id && !c.archived).sort((a, b) => a.order - b.order)) {
      if (c.excludeFromBudget) continue;
      const p = planned[c.id] ?? 0;
      const a = actuals.get(c.id) ?? 0;
      if (!p && !a) continue;
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
  for (const t of db.transactions) {
    if (t.date < cutoff || categoryKind(db, t.categoryId) === "transfer") continue;
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
