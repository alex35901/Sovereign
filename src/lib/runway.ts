import type { DB, ISODate } from "../types.js";
import { addDays, today } from "./date.js";
import { occurrences, paidOccurrences, recurringList } from "./select.js";

/**
 * Whether the money in the current account gets you to payday.
 *
 * The forecast answers what happens in 2056. This answers the question people
 * actually open a budgeting app to ask, which is whether the card will go
 * through on Thursday. Everything it needs is already here: what is in
 * checking, which bills are coming, and when pay next lands.
 *
 * Deliberately conservative in three places, because a "safe to spend" figure
 * that turns out to be optimistic is worse than no figure at all:
 *
 *   - Checking only. Savings is money somebody has decided not to spend, and
 *     counting it turns a buffer into a balance.
 *   - Every bill between now and payday, whether or not it has come out yet.
 *   - A bill already paid this cycle is taken off, so nothing is counted twice.
 */

/** How far ahead to look when nothing recurring says when pay arrives. */
export const DEFAULT_HORIZON_DAYS = 14;

/** Accounts a bill actually comes out of. */
const SPENDABLE = new Set(["checking"]);

export interface Due {
  date: ISODate;
  merchant: string;
  /** Signed as it is stored: an outflow is negative. */
  amount: number;
}

export interface Runway {
  /** What is in the current accounts right now. */
  cash: number;
  /** When pay next lands, if anything recurring knows. */
  nextIncome: Due | null;
  /** The day the window closes: payday, or the fallback horizon. */
  until: ISODate;
  /** Whole days from today to `until`. Zero when payday is today. */
  days: number;
  /** Bills falling due inside the window and not yet paid, soonest first. */
  bills: Due[];
  /** What they come to, as a positive number. */
  billsTotal: number;
  /** Cash less the bills. Negative means short before payday. */
  free: number;
  /** What that leaves for each remaining day, or null when there are none. */
  perDay: number | null;
  /** True when the window is a guess rather than a known payday. */
  guessed: boolean;
}

export function runway(db: DB, now: ISODate = today()): Runway {
  const cash = db.accounts
    .filter((a) => SPENDABLE.has(a.type) && !a.hidden && !a.closedAt)
    .reduce((n, a) => n + a.balance, 0);

  const list = recurringList(db);
  const horizon = addDays(now, DEFAULT_HORIZON_DAYS);

  // The soonest money in, looked for over a wider window than the default one
  // so a monthly salary is still found in the days just after it lands.
  const far = addDays(now, 45);
  let nextIncome: Due | null = null;
  for (const r of list) {
    if (r.kind !== "income") continue;
    for (const date of occurrences(r, addDays(now, 1), far)) {
      if (!nextIncome || date < nextIncome.date) {
        nextIncome = { date, merchant: r.merchant, amount: Math.abs(r.amount) };
      }
      break;
    }
  }

  const guessed = !nextIncome;
  const until = nextIncome ? nextIncome.date : horizon;
  const days = Math.max(0, Math.round((Date.parse(until) - Date.parse(now)) / 86_400_000));

  const bills: Due[] = [];
  for (const r of list) {
    if (r.kind === "income") continue;
    // From today, not tomorrow: a bill dated today has usually not come out
    // yet, and the one case where it has is caught by the paid check below.
    const paid = paidOccurrences(db, r, now, until);
    for (const date of occurrences(r, now, until)) {
      if (paid.has(date)) continue;
      bills.push({ date, merchant: r.merchant, amount: -Math.abs(r.amount) });
    }
  }
  bills.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const billsTotal = bills.reduce((n, b) => n + Math.abs(b.amount), 0);
  const free = cash - billsTotal;
  return {
    cash, nextIncome, until, days, bills, billsTotal, free,
    // Rounded down: a figure that rounds up is a figure that runs out a day
    // early. Null on payday itself, where "per day" divides by nothing.
    perDay: days > 0 ? Math.floor(free / days) : null,
    guessed,
  };
}
