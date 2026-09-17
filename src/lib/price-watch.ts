import type { Cadence, DB, ID, ISODate, Recurring, Transaction } from "../types.js";
import { addDays, today } from "./date.js";
import { categoryKind, counts, mutedAccountIds, recurringList } from "./select.js";

/**
 * Subscriptions that quietly went up.
 *
 * Nobody notices two dollars. Six of them over a year is a car service, and
 * the only reason it goes unnoticed is that the charge has the same name it
 * always had. The document already knows every price ever paid, so this is
 * arithmetic rather than a feature anybody has to remember to use.
 *
 * Conservative by construction. A change is only reported when the old price
 * was *settled*: the same figure, to the cent, at least twice in a row. That
 * single rule is what keeps the electricity bill out. A utility that swings
 * with the season never charges the same amount twice running, so it never
 * has an old price to have moved away from, and no threshold or special case
 * is needed to exclude it.
 */

/** How far back a price is worth comparing against, at the shortest. */
export const WATCH_DAYS = 500;

/** And at the longest, so a lapsed yearly plan does not haunt the list. */
export const MAX_WATCH_DAYS = 5 * 365;

/** The old price has to have held this many times running to count as settled. */
export const SETTLED_RUN = 2;

/** Below these it is a rounding difference, not a price rise. */
export const MIN_DELTA = 50;
export const MIN_SHARE = 0.02;

/**
 * Charges a year, for annualising a change.
 *
 * Fifty-two, not fifty-three: a calendar year holds fifty-three Fridays some
 * years, but the rate at which a weekly charge arrives is fifty-two, and the
 * question here is what a rise costs per year rather than how many land in
 * one particular one.
 */
export const PER_YEAR: Record<Cadence, number> = {
  weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, semiannual: 2, yearly: 1,
};

export interface PriceChange {
  id: ID;
  merchant: string;
  kind: Recurring["kind"];
  cadence: Cadence;
  /** Both positive: what it was, and what it is. */
  was: number;
  now: number;
  /** Positive for a rise, negative for a cut. */
  delta: number;
  /** As a share of the old price, in percent. */
  share: number;
  /** The day it first charged the new price. */
  at: ISODate;
  /** How many times the old price held, and how many the new one has. */
  held: number;
  since: number;
  /** What the change costs, or saves, over a year at this cadence. */
  yearly: number;
}

/**
 * How far back to look for one item.
 *
 * Long enough for about five charges at its own cadence, because a yearly
 * subscription that has only billed twice inside the window has no settled
 * price and would be reported on for ever as "nothing to say". Five hundred
 * days is plenty for anything monthly or shorter, so the floor covers the
 * common case and the cadence covers the rest.
 */
export const windowDays = (cadence: Cadence): number =>
  Math.min(MAX_WATCH_DAYS, Math.max(WATCH_DAYS, Math.round((365 / PER_YEAR[cadence]) * 5)));

const key = (s: string): string => s.toLowerCase().trim();

/** Every charge a recurring item has made, oldest first, as positive amounts. */
function chargesFor(db: DB, r: Recurring, from: ISODate, to: ISODate): { date: ISODate; amount: number }[] {
  const muted = mutedAccountIds(db);
  const want = key(r.merchant);
  const out: { date: ISODate; amount: number }[] = [];
  for (const t of db.transactions as Transaction[]) {
    if (t.date < from || t.date > to) continue;
    if (key(t.merchant) !== want) continue;
    if (!counts(t, muted) || categoryKind(db, t.categoryId) === "transfer") continue;
    // A refund is not a price. Only charges in the direction the item bills in.
    if (Math.sign(t.amount) !== Math.sign(r.amount)) continue;
    out.push({ date: t.date, amount: Math.abs(t.amount) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** The length of the run of equal amounts ending at `end`. */
function runBack(charges: { amount: number }[], end: number): number {
  const amount = charges[end].amount;
  let i = end;
  while (i > 0 && charges[i - 1].amount === amount) i--;
  return end - i + 1;
}

/**
 * What has changed price, dearest rise first.
 *
 * Income is left out. A pay rise is worth knowing and it is not what this is;
 * it arrives through a different door and would sit oddly in a list of things
 * that got more expensive.
 */
export function priceChanges(db: DB, now: ISODate = today()): PriceChange[] {
  const out: PriceChange[] = [];

  for (const r of recurringList(db)) {
    if (r.kind === "income") continue;
    const charges = chargesFor(db, r, addDays(now, -windowDays(r.cadence)), now);
    if (charges.length < SETTLED_RUN + 1) continue;

    const last = charges.length - 1;
    const since = runBack(charges, last);
    const before = last - since;
    if (before < 0) continue;

    const held = runBack(charges, before);
    if (held < SETTLED_RUN) continue;

    const was = charges[before].amount;
    const nowAmount = charges[last].amount;
    const delta = nowAmount - was;
    if (was <= 0 || Math.abs(delta) < MIN_DELTA || Math.abs(delta) / was < MIN_SHARE) continue;

    out.push({
      id: r.id,
      merchant: r.merchant,
      kind: r.kind,
      cadence: r.cadence,
      was,
      now: nowAmount,
      delta,
      share: Math.round((delta / was) * 1000) / 10,
      at: charges[last - since + 1].date,
      held,
      since,
      yearly: delta * PER_YEAR[r.cadence],
    });
  }

  return out.sort((a, b) => b.yearly - a.yearly);
}

/** What every rise and cut comes to over a year. Positive means it costs more. */
export const yearlyImpact = (changes: readonly PriceChange[]): number =>
  changes.reduce((n, c) => n + c.yearly, 0);
