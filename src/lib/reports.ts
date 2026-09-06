import type { DB, ISODate, MonthKey } from "../types.js";
import { monthOf } from "./date.js";
import { categoryKind, counts, lines, merchantKey, mutedAccountIds } from "./select.js";

/**
 * What the Reports screen is made of.
 *
 * Every figure here is a share of a whole, so they all have to be counted the
 * same way or the shares stop adding up. One rule, applied once: a line counts
 * if its account is not muted, the transaction is not hidden from reports, and
 * its category is not a transfer — money moving between your own accounts is
 * neither income nor spending, and counting it would inflate both sides of
 * every comparison on the page.
 */

export type Side = "income" | "expense";
export type Facet = "category" | "group" | "merchant";

export interface Slice {
  key: string;
  label: string;
  icon?: string;
  tone: string;
  /** Always positive: which side it is on is the caller's question, not the row's. */
  total: number;
  count: number;
  /** Where the row leads, or null when it has no page of its own. */
  to: string | null;
}

/** One line of one transaction, once it has earned its place in a report. */
interface Line { categoryId: string; amount: number; merchant: string }

function reportable(db: DB, from: ISODate, to: ISODate, side: Side): Line[] {
  const muted = mutedAccountIds(db);
  const kind = new Map(db.categories.map((c) => [c.id, categoryKind(db, c.id)]));
  const out: Line[] = [];
  for (const t of db.transactions) {
    if (t.date < from || t.date > to || !counts(t, muted)) continue;
    for (const l of lines(t)) {
      if (kind.get(l.categoryId) === "transfer") continue;
      // Which side a line falls on is its own sign, not its category's. A
      // refund sits in a spending category and is money coming back; counting
      // it as spending would overstate the category it landed in.
      if (side === "income" ? l.amount <= 0 : l.amount >= 0) continue;
      out.push({ categoryId: l.categoryId, amount: Math.abs(l.amount), merchant: t.merchant });
    }
  }
  return out;
}

export function breakdown(db: DB, from: ISODate, to: ISODate, side: Side, facet: Facet): Slice[] {
  const cats = new Map(db.categories.map((c) => [c.id, c]));
  const groups = new Map(db.groups.map((g) => [g.id, g]));
  const tally = new Map<string, { total: number; count: number; label: string; icon?: string; tone: string; to: string | null }>();

  for (const l of reportable(db, from, to, side)) {
    let key = l.categoryId;
    let label = cats.get(l.categoryId)?.name ?? "Uncategorized";
    let icon = cats.get(l.categoryId)?.icon;
    let tone = cats.get(l.categoryId)?.color ?? "--c12";
    let to: string | null = `/categories/${l.categoryId}`;

    if (facet === "group") {
      const g = groups.get(cats.get(l.categoryId)?.groupId ?? "");
      key = g?.id ?? "ungrouped";
      label = g?.name ?? "Ungrouped";
      icon = undefined;
      tone = g?.color ?? tone;
      // A group has no page of its own, so its row is a figure rather than a
      // way in. Better a row that does nothing than one that goes somewhere
      // unrelated.
      to = null;
    } else if (facet === "merchant") {
      key = merchantKey(l.merchant);
      label = l.merchant;
      icon = undefined;
      tone = "--c2";
      to = `/merchants/${encodeURIComponent(l.merchant)}`;
    }

    const cur = tally.get(key) ?? { total: 0, count: 0, label, icon, tone, to };
    cur.total += l.amount;
    cur.count += 1;
    tally.set(key, cur);
  }

  return [...tally.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.total - a.total || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

export interface Summary {
  total: number;
  count: number;
  /** The single biggest line, which is often the explanation for the total. */
  largest: number;
  average: number;
}

export function summarise(db: DB, from: ISODate, to: ISODate, side: Side): Summary {
  const ls = reportable(db, from, to, side);
  const total = ls.reduce((s, l) => s + l.amount, 0);
  return {
    total,
    count: ls.length,
    largest: ls.reduce((m, l) => Math.max(m, l.amount), 0),
    // Rounded to the penny, because an average of thirds is not a real sum of
    // money and a fraction of one would show up in the total's last digit.
    average: ls.length ? Math.round(total / ls.length) : 0,
  };
}

/* ── the cash-flow bars ───────────────────────────────────────────────── */

export type Grain = "monthly" | "yearly";

export interface FlowBucket {
  key: string;
  label: string;
  income: number;
  expense: number;
  net: number;
}

/**
 * Income and spending per period, and what was left.
 *
 * Yearly is the months added up rather than a second pass over the
 * transactions, so the two grains cannot disagree about a year the way two
 * separate counts would.
 */
export function flowBuckets(perMonth: { month: MonthKey; income: number; expense: number }[], grain: Grain): FlowBucket[] {
  if (grain === "monthly") {
    return perMonth.map((p) => ({
      key: p.month,
      label: p.month,
      income: p.income,
      expense: p.expense,
      net: p.income - p.expense,
    }));
  }
  const years = new Map<string, { income: number; expense: number }>();
  for (const p of perMonth) {
    const y = p.month.slice(0, 4);
    const cur = years.get(y) ?? { income: 0, expense: 0 };
    cur.income += p.income;
    cur.expense += p.expense;
    years.set(y, cur);
  }
  return [...years.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([y, v]) => ({ key: y, label: y, income: v.income, expense: v.expense, net: v.income - v.expense }));
}

/* ── the sankey ───────────────────────────────────────────────────────── */

export interface SankeyNode { id: string; label: string; value: number; color: string; depth: number }
export interface SankeyLink { source: string; target: string; value: number }

/** Below this share of the outgoing side, a band is folded into "Everything else". */
export const SANKEY_TAIL = 0.04;

/**
 * Where the money came from and where it went, in one picture.
 *
 * Three columns: what came in, a single node holding all of it, and what it
 * turned into. Both sides come from the same `breakdown` the lists on this
 * screen use, so the diagram and the figures beside it cannot disagree — and
 * it can be cut by category, group or merchant like everything else here.
 *
 * Anything not spent is a band of its own labelled Saved, because a diagram
 * whose outgoing bands are thinner than its incoming ones, with no
 * explanation, looks like an arithmetic error rather than a surplus.
 *
 * A period that spent more than it earned has no surplus to draw. The
 * overspend is not invented as a fourth incoming band — it came from savings
 * this picture does not cover — so the outgoing side is simply wider, which is
 * the honest shape of that period.
 *
 * Small bands are folded into one. Forty categories at two pixels each is a
 * fringe rather than a diagram, and the labels on the right stop being
 * readable long before the bands do.
 */
export function sankeyData(
  db: DB, from: ISODate, to: ISODate, facet: Facet = "group",
): { nodes: SankeyNode[]; links: SankeyLink[] } {
  const sources = breakdown(db, from, to, "income", facet);
  const sinks = breakdown(db, from, to, "expense", facet);
  const totalIn = sources.reduce((s, x) => s + x.total, 0);
  const totalOut = sinks.reduce((s, x) => s + x.total, 0);

  const nodes: SankeyNode[] = [{ id: "hub", label: "Cash flow", value: totalIn, color: "--pos", depth: 1 }];
  const links: SankeyLink[] = [];

  let inTail = 0;
  for (const s of sources) {
    if (totalIn > 0 && s.total / totalIn < SANKEY_TAIL) { inTail += s.total; continue; }
    nodes.push({ id: `in_${s.key}`, label: s.label, value: s.total, color: s.tone, depth: 0 });
    links.push({ source: `in_${s.key}`, target: "hub", value: s.total });
  }
  if (inTail > 0) {
    nodes.push({ id: "in_tail", label: "Everything else", value: inTail, color: "--c12", depth: 0 });
    links.push({ source: "in_tail", target: "hub", value: inTail });
  }

  let outTail = 0;
  for (const s of sinks) {
    if (totalOut > 0 && s.total / totalOut < SANKEY_TAIL) { outTail += s.total; continue; }
    nodes.push({ id: `out_${s.key}`, label: s.label, value: s.total, color: s.tone, depth: 2 });
    links.push({ source: "hub", target: `out_${s.key}`, value: s.total });
  }
  if (outTail > 0) {
    nodes.push({ id: "out_tail", label: "Everything else", value: outTail, color: "--c12", depth: 2 });
    links.push({ source: "hub", target: "out_tail", value: outTail });
  }

  if (totalIn > totalOut) {
    nodes.push({ id: "out_saved", label: "Saved", value: totalIn - totalOut, color: "--c3", depth: 2 });
    links.push({ source: "hub", target: "out_saved", value: totalIn - totalOut });
  }

  return { nodes, links };
}

/** Months touched by any transaction, for a range picker that offers real ones. */
export const monthsWithData = (db: DB): MonthKey[] =>
  [...new Set(db.transactions.map((t) => monthOf(t.date)))].sort();
