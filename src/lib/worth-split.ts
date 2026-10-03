import type { Account, DB, ISODate } from "../types.js";
import { balanceAt, counts, mutedAccountIds } from "./select.js";

/**
 * Net worth went up. How much of that was you?
 *
 * A month where everything rose reads identically whether the household saved
 * four thousand or the market did. They are not the same month, and only one
 * of them says anything about how the household is doing: one can be repeated
 * on purpose, and the other happens to you.
 *
 * The split is arithmetic rather than judgement. Some accounts only move
 * because money went in or out of them, and every one of those movements is a
 * transaction this document already holds. The rest - a brokerage, a pension,
 * a house, a car - move on their own, and what they did beyond the money put
 * into them is the market, or the valuer, or depreciation.
 *
 *   market = for each account that moves on its own:
 *              (what it is worth now - what it was worth then) - what went into it
 *   saved  = (net worth now - net worth then) - market
 *
 * Which makes saved everything else: pay landing, bills leaving, a mortgage
 * being paid down. That is the right way round. The market half is the part
 * that can be measured precisely, and the household half is the part worth
 * knowing, so the precise one is measured and the other is what is left.
 */

/**
 * Accounts whose value moves without anybody doing anything.
 *
 * A current account does not belong here even though its balance changes
 * daily: every one of those changes is a transaction. Nor does a credit card
 * or a loan, whose balance is the sum of what was spent and repaid.
 */
const MOVES_ALONE = new Set<Account["type"]>([
  "investment", "retirement", "crypto", "real_estate", "vehicle",
]);

export interface WorthSplit {
  from: ISODate;
  to: ISODate;
  /** What net worth did over the window. */
  change: number;
  /** What the things that move on their own did, beyond what was put in. */
  market: number;
  /** Everything else: pay in, bills out, debt paid down. */
  saved: number;
  /** Money that went into the accounts that move on their own. */
  contributed: number;
  /**
   * Accounts whose whole movement was put down to the market because nothing
   * records what went into them.
   *
   * The one place this can mislead. A brokerage that arrives as a balance and
   * a list of holdings, with no transactions, cannot tell a contribution from
   * a good week, so the contribution is counted as market and the household's
   * own saving is understated by exactly that much. Said out loud rather than
   * quietly folded in.
   */
  unattributed: { id: string; name: string; moved: number }[];
}

/**
 * @param from the day before the window: balances are read as they stood at
 * the end of it, so a window of "this month" starts on the last day of last.
 */
export function worthSplit(db: DB, from: ISODate, to: ISODate): WorthSplit {
  const live = db.accounts.filter((a) => a.includeInNetWorth && !a.hidden);
  const muted = mutedAccountIds(db);

  let change = 0;
  let market = 0;
  let contributed = 0;
  const unattributed: WorthSplit["unattributed"] = [];

  for (const account of live) {
    const moved = balanceAt(account, to) - balanceAt(account, from);
    change += moved;
    if (!MOVES_ALONE.has(account.type)) continue;

    // What went in, by the same rule the budget counts a transaction by, so a
    // row kept out of the figures everywhere else is kept out here too.
    let into = 0;
    let rows = 0;
    for (const t of db.transactions) {
      if (t.accountId !== account.id) continue;
      if (t.date <= from || t.date > to) continue;
      if (!counts(t, muted)) continue;
      into += t.amount;
      rows += 1;
    }
    contributed += into;
    market += moved - into;
    // Nothing recorded against it at all, so none of its movement could be
    // attributed. An account that genuinely had no activity is indistinguishable
    // from one whose activity is not recorded, and the honest reading of both
    // is "this is all market, as far as this document can tell".
    if (!rows && moved !== 0) unattributed.push({ id: account.id, name: account.name, moved });
  }

  return { from, to, change, market, saved: change - market, contributed, unattributed };
}
