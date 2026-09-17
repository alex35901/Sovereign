import type { Account, BalancePoint, DB, ID, ISODate } from "../types.js";
import { SWING_FLOOR, SWING_SHARE } from "./notifications.js";

/**
 * Readings a provider got wrong, and how to take them back out.
 *
 * Every chart in this app derives net worth from the balance history rather
 * than storing its own, which is the right way round: correct an account and
 * every figure that reads it follows. What does not follow is history a
 * provider already wrote. When NewRez reported an escrow balance where the
 * loan principal had been, that wrong figure went into the record for the days
 * it was live, and correcting today's balance leaves those days alone - so the
 * net worth line still carries a four hundred thousand dollar spike that never
 * happened.
 *
 * The repair has to be asked for, never done quietly: a balance that falls by
 * almost all of itself is usually a mistake and occasionally a mortgage being
 * paid off, and the document cannot tell those apart. So the rule here is
 * deliberately narrow, and it is the one thing a payoff can never look like:
 *
 *   an excursion is only reported when the readings on BOTH sides of it
 *   disagree with it.
 *
 * A real payoff never comes back. An excursion that left and returned is the
 * provider having had a bad week, and that is the only shape offered for
 * removal.
 */

/** How far back towards the old figure counts as having come back. */
export const RECOVERED = 0.5;

export interface BadRun {
  accountId: ID;
  name: string;
  /** The last reading before it went wrong. The chart holds here once dropped. */
  before: BalancePoint;
  /** The first reading that came back. Its presence is what makes this a run. */
  after: BalancePoint;
  from: ISODate;
  to: ISODate;
  /** The readings that would go. */
  points: BalancePoint[];
  /** What the run was reporting, and what the readings either side say. */
  reported: number;
  expected: number;
}

/** The same test the balance-swing notice uses, so one cannot fire without the other. */
const swung = (before: number, after: number): boolean => {
  const b = Math.abs(before);
  const a = Math.abs(after);
  if (Math.abs(a - b) < SWING_FLOOR) return false;
  return (b > 0 && a <= b * (1 - SWING_SHARE)) || (a > 0 && b <= a * (1 - SWING_SHARE));
};

/**
 * Excursions in one account's history.
 *
 * Only on accounts a provider writes. A figure somebody typed in is a figure
 * somebody meant, and offering to delete it is not help.
 */
export function badRuns(account: Account): BadRun[] {
  if (!account.syncSource || account.syncSource === "manual" || account.syncSource === "csv") return [];
  const h = account.history;
  if (h.length < 3) return [];

  const out: BadRun[] = [];
  let i = 1;
  while (i < h.length) {
    const before = h[i - 1]!;
    if (!swung(before.balance, h[i]!.balance)) { i++; continue; }

    // How far the reading moved. Coming back more than half of that is coming
    // back: scale-free, so it reads the same on a mortgage and on a card.
    const gap = Math.abs(h[i]!.balance - before.balance);
    let end = i;
    while (end + 1 < h.length && Math.abs(h[end + 1]!.balance - before.balance) > gap / 2) end++;

    const after = h[end + 1];
    // Nothing after it, or nothing that came back: this is where the account
    // is now, not an excursion, and it is not ours to remove.
    if (!after) break;

    out.push({
      accountId: account.id,
      name: account.name,
      before,
      after,
      from: h[i]!.date,
      to: h[end]!.date,
      points: h.slice(i, end + 1),
      reported: h[i]!.balance,
      expected: before.balance,
    });
    i = end + 2;
  }
  return out;
}

/** Every excursion the document can see, newest account first is not a thing, so by date. */
export function badRunsIn(db: DB): BadRun[] {
  return db.accounts
    .filter((a) => !a.closedAt)
    .flatMap((a) => badRuns(a))
    .sort((x, y) => (x.from < y.from ? 1 : -1));
}

/**
 * The history without that stretch.
 *
 * Dropped rather than replaced with a guess. What the balance really was on
 * those days is not something the document knows, and forward-filling the last
 * good reading is what `balanceAt` already does for a day with no reading at
 * all - so the line holds flat across the gap and says, correctly, that
 * nothing was known.
 */
export const dropRun = (history: readonly BalancePoint[], from: ISODate, to: ISODate): BalancePoint[] =>
  history.filter((h) => h.date < from || h.date > to);

/** What the spike was worth, for saying so before it is removed. */
export const runOverstatement = (run: BadRun): number => run.reported - run.expected;
