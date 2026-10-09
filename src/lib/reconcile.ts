import type { Account, DB, ID, ISODate, MonthKey } from "../types.js";
import { addMonths, monthEnd, monthOf, today } from "./date.js";
import { balanceAt, rolloverFor } from "./select.js";

/**
 * Checking an account against the envelopes it is supposed to be holding.
 *
 * The month-end job somebody does by hand: add up what every rollover category
 * still has left, and see whether the account the money actually sits in holds
 * that much. A difference is not automatically wrong, but it is always worth
 * knowing, and it is the only way to catch money that has quietly stopped
 * being accounted for.
 *
 * Worked out from what the document already holds rather than written down
 * once a month and kept. The figures are both derivable: the balance from the
 * account's own history, the carry from the budgets. Storing a snapshot
 * instead would mean a month nobody opened the app in has no row at all and
 * never will, and a transaction recategorised in September would leave August
 * reporting a figure that was true once and is not now, which is the one thing
 * an audit cannot do.
 */
export interface ReconcileRow {
  month: MonthKey;
  /** What the account held at the end of that month. */
  balance: number;
  /** What the tied categories carried out of it. */
  rollover: number;
  /** Account less envelopes. Positive means the account holds more than the envelopes claim. */
  difference: number;
}

/** The categories this account is reconciled against, as the document holds them. */
export const tiedCategories = (db: DB, account: Pick<Account, "rolloverCategoryIds">): ID[] => {
  const want = new Set(account.rolloverCategoryIds ?? []);
  // Read back through the document rather than trusted: a category deleted
  // since, or one whose rollover was switched off, is not holding anything.
  return db.categories.filter((c) => want.has(c.id) && c.rollover).map((c) => c.id);
};

/**
 * The first month worth showing.
 *
 * Where the budgets start, because a carry is made of planned figures and
 * there is none before the first of them. Bounded at the account's own first
 * balance too: a row for a month before the account existed compares nothing
 * against something.
 */
function firstMonth(db: DB, account: Account): MonthKey | null {
  const planned = Object.keys(db.budgets).sort()[0];
  if (!planned) return null;
  const opened = account.history[0]?.date;
  return opened && monthOf(opened) > planned ? monthOf(opened) : planned;
}

/**
 * Every month from the first to this one, newest first.
 *
 * The current month is included and is simply not finished: the balance is
 * where the account stands today and the carry is what it would hand on if the
 * month ended now, which is the figure somebody watches as the month closes.
 */
export function reconcileRows(db: DB, account: Account, now: ISODate = today()): ReconcileRow[] {
  const tied = tiedCategories(db, account);
  if (!tied.length) return [];
  const from = firstMonth(db, account);
  if (!from) return [];

  const out: ReconcileRow[] = [];
  const last = monthOf(now);
  for (let m = from; m <= last; m = addMonths(m, 1)) {
    // As at the end of the month, or as at today for the one still running:
    // an account has no balance on a date that has not happened.
    const at = monthEnd(m) > now ? now : monthEnd(m);
    const balance = balanceAt(account, at);
    // The carry *out* of this month is the carry *into* the next one, which is
    // what rolloverFor answers: it counts every month before the one asked.
    const next = addMonths(m, 1);
    const rollover = tied.reduce((sum, id) => sum + rolloverFor(db, next, id), 0);
    out.push({ month: m, balance, rollover, difference: balance - rollover });
  }
  return out.reverse();
}

/** Whether this account is reconciled at all, which is what hides the table. */
export const isReconciled = (db: DB, account: Pick<Account, "rolloverCategoryIds">): boolean =>
  tiedCategories(db, account).length > 0;
