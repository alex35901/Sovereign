import type { DB, ID } from "../types.js";
import { addMonths, thisMonth } from "./date.js";
import type { MonthKey } from "../types.js";
import { DEBT_DEFAULTS, debtMonthlyRate, levelPayment } from "./forecast.js";

/**
 * Where the next spare dollar should go, and what it buys.
 *
 * Two orders, and the argument between them is older than any of this. The
 * avalanche pays the dearest rate first and costs strictly less; the snowball
 * clears the smallest balance first and gets you an account closed sooner. The
 * app does not pick: it runs both and prints the difference, because the
 * honest answer is that one saves money and the other keeps people going, and
 * which matters more is not a thing arithmetic knows.
 *
 * Everything here is a month-by-month walk over the same level payments the
 * forecast uses. Interest is charged on the balance at the start of the month,
 * at a twelfth of the APR, which is what a lender does.
 */

export type Order = "avalanche" | "snowball";

export interface Debt {
  id: ID;
  name: string;
  /** Positive: what is owed. */
  balance: number;
  apr: number;
  /** The minimum due each month. */
  minimum: number;
}

export interface PaidOff {
  id: ID;
  name: string;
  /** The month it reaches zero. */
  month: MonthKey;
  /** Months from the start. */
  after: number;
  interest: number;
}

export interface Plan {
  order: Order;
  /** What goes out every month until the last debt clears. */
  monthly: number;
  /** In the order they are cleared. */
  cleared: PaidOff[];
  /** The month the last one goes. Null if it never does. */
  debtFree: MonthKey | null;
  months: number | null;
  interest: number;
  /** Balance owed at the end of each month, for a chart. */
  curve: { month: MonthKey; owed: number }[];
}

/** Long enough for a thirty-year mortgage, short enough to end. */
const MAX_MONTHS = 600;

/**
 * The order the spare money is thrown at them.
 *
 * Sorted once, at the start, rather than re-sorted as balances fall: the
 * avalanche is about rates, which do not move, and re-sorting a snowball each
 * month would have it chase whichever debt happened to be smallest that
 * month instead of finishing what it started.
 */
export function attackOrder(debts: readonly Debt[], order: Order): Debt[] {
  const live = debts.filter((d) => d.balance > 0);
  return [...live].sort((a, b) => (order === "avalanche"
    // Dearest first; a tie goes to the smaller balance, which clears sooner
    // and frees its minimum for everything behind it.
    ? b.apr - a.apr || a.balance - b.balance
    : a.balance - b.balance || b.apr - a.apr));
}

/**
 * The walk, at `extra` a month on top of the minimums.
 *
 * The minimum of a debt that has been cleared is not saved, it is added to
 * what attacks the next one. That rolling-up is the whole mechanism, and it is
 * why both orders finish far sooner than paying minimums forever.
 */
export function payoffPlan(
  debts: readonly Debt[],
  order: Order,
  extra: number,
  from: MonthKey = thisMonth(),
): Plan {
  const queue = attackOrder(debts, order);
  const state = queue.map((d) => ({ ...d, owed: d.balance, interest: 0 }));
  const monthly = state.reduce((n, d) => n + d.minimum, 0) + Math.max(0, extra);

  const cleared: PaidOff[] = [];
  const curve: { month: MonthKey; owed: number }[] = [];
  let interest = 0;

  for (let i = 0; i < MAX_MONTHS; i++) {
    const month = addMonths(from, i);
    const open = state.filter((d) => d.owed > 0);
    if (!open.length) break;

    // Interest first, on what was owed when the month began.
    for (const d of open) {
      const charge = d.owed * debtMonthlyRate(d.apr);
      d.owed += charge;
      d.interest += charge;
      interest += charge;
    }

    // Everything freed by a cleared debt rolls into this month's budget, which
    // is what makes either order beat paying minimums for ever.
    let budget = monthly;
    for (const d of open) {
      if (budget <= 0) break;
      const pay = Math.min(budget, d.minimum, d.owed);
      d.owed -= pay;
      budget -= pay;
    }
    // Whatever is left goes at the front of the queue, then the next, and so
    // on: a month with a large surplus can clear two small debts at once.
    for (const d of state) {
      if (budget <= 0) break;
      if (d.owed <= 0) continue;
      const pay = Math.min(budget, d.owed);
      d.owed -= pay;
      budget -= pay;
    }

    for (const d of state) {
      if (d.owed > 0 || cleared.some((c) => c.id === d.id)) continue;
      d.owed = 0;
      cleared.push({ id: d.id, name: d.name, month, after: i + 1, interest: Math.round(d.interest) });
    }
    curve.push({ month, owed: Math.round(state.reduce((n, d) => n + Math.max(0, d.owed), 0)) });
  }

  const done = state.every((d) => d.owed <= 0);
  const last = cleared[cleared.length - 1];
  return {
    order,
    monthly: Math.round(monthly),
    cleared,
    debtFree: done && last ? last.month : null,
    months: done && last ? last.after : null,
    interest: Math.round(interest),
    curve,
  };
}

/** What the two orders cost against each other, at the same monthly outlay. */
export function compareOrders(debts: readonly Debt[], extra: number, from: MonthKey = thisMonth()) {
  const avalanche = payoffPlan(debts, "avalanche", extra, from);
  const snowball = payoffPlan(debts, "snowball", extra, from);
  return {
    avalanche,
    snowball,
    /** What the snowball costs over the avalanche. Never negative. */
    costsExtra: Math.max(0, snowball.interest - avalanche.interest),
    /** How much sooner the snowball closes its first account. Often zero. */
    firstWinSooner: (snowball.cleared[0] && avalanche.cleared[0])
      ? avalanche.cleared[0].after - snowball.cleared[0].after
      : 0,
  };
}

/**
 * The debts as the document holds them.
 *
 * The minimum is the level payment the forecast already works out from the
 * balance, the rate and the years left, so a household sees one figure for a
 * mortgage payment here and on the forecast screen rather than two.
 */
export function debtsFrom(db: DB): Debt[] {
  const terms = db.forecast?.scenarios.find((s) => s.id === db.forecast?.activeId)?.assumptions.debts ?? {};
  const out: Debt[] = [];
  for (const a of db.accounts) {
    if (a.hidden || a.closedAt || a.balance >= 0) continue;
    if (!["credit", "loan", "mortgage", "other_liability"].includes(a.type)) continue;
    const t = terms[a.id] ?? DEBT_DEFAULTS[a.type] ?? DEBT_DEFAULTS.other_liability;
    out.push({
      id: a.id,
      name: a.name,
      balance: Math.abs(a.balance),
      apr: t.apr,
      minimum: Math.round(levelPayment(a.balance, t.apr, t.termMonths)),
    });
  }
  return out;
}
