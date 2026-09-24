import type { Account, DB } from "../types.js";
import { cadenceHours, DEFAULT_CADENCE } from "./sync/schedule.js";
import { meterOf } from "./usage.js";
import { quietFor } from "./quiet.js";
import { namesABank, noteFor } from "./sync/notes.js";

/**
 * Where an account's balance comes from, and whether it is still coming.
 *
 * The Accounts list can only say when a balance last arrived. That answers
 * "is this figure fresh" but not "is it going to stay fresh", which is the
 * question worth asking on the account's own page: a connection that broke
 * three weeks ago looks exactly like an account nobody has spent from, right
 * up until the moment it matters.
 *
 * So this is worked out rather than stored. A stored status is a status that
 * can be wrong — it would have to be written by whatever last touched the
 * account, and the thing that most needs reporting is the sync that never ran
 * at all.
 */

export type ConnectionState = "connected" | "attention" | "stale" | "manual";

export interface Connection {
  state: ConnectionState;
  /** What the Status row reads. */
  status: string;
  /** Who supplies it, in words. */
  provider: string;
  /** When a balance last arrived, if one ever has. */
  lastAt?: string;
  /** The reason it needs attention, when it does. */
  detail?: string;
}

const PROVIDER: Record<string, string> = {
  plaid: "Plaid",
  simplefin: "SimpleFIN",
  csv: "CSV import",
  manual: "Entered by hand",
};

/**
 * How far behind its own schedule a connection may fall before it is worth
 * mentioning.
 *
 * Three times the cadence, not a fixed number of days: a budget syncing weekly
 * is not in trouble on day two, and one syncing hourly has a real problem long
 * before day three. Three misses is late enough that it is unlikely to be the
 * laptop having been shut.
 */
export const MISSES = 3;

export function connectionOf(account: Account, db: DB, now: number = Date.now()): Connection {
  const source = account.syncSource ?? "manual";
  const provider = PROVIDER[source] ?? source;
  const lastAt = account.lastSyncedAt;

  // Nothing is connected, so nothing can be wrong with the connection. Saying
  // "needs attention" about an account that was only ever typed in would be
  // inventing a fault to go and fix.
  if (source === "manual" || source === "csv") {
    return {
      state: "manual", provider, lastAt,
      status: source === "csv" ? "Imported from a file" : "Kept up to date by hand",
    };
  }

  // What the provider said about this account in particular, which beats
  // anything it said about the pull as a whole: "we are upgrading this
  // connection" belongs on the connection being upgraded, not on the four
  // that are fine.
  if (account.syncNote) {
    return { state: "attention", provider, lastAt, status: "Needs attention", detail: account.syncNote.message };
  }

  /**
   * The provider's own last word, which is what the Settings health column
   * reads. Cleared by the next run that comes back at all.
   *
   * Only one error is kept per provider, and the Plaid path writes it as
   * "Valon Mortgage: ...", so every Plaid account in the document was
   * reporting one mortgage's trouble as its own: a chequing account at a
   * different bank, sitting under a red line about a connection it has
   * nothing to do with. The comment here used to assert that an error at this
   * level names no institution. It was true of the path it was written for
   * and not of the one added later, which is exactly the kind of invariant
   * worth checking rather than believing.
   *
   * So a message that names a bank is shown on that bank's accounts and
   * nowhere else. One that names nobody is about the connection as a whole
   * and is still shown on all of them.
   */
  const error = meterOf(db.settings.usage, source, "ever", now).error;
  /**
   * Every bank this document knows by name, whether or not an account has
   * arrived for it.
   *
   * The connections themselves count, not just the accounts. "Plaid is still
   * preparing this connection's transactions" is by definition a message about
   * a bank that has no accounts here yet, so matching only against accounts
   * decided it named nobody, which meant showing it against everybody: the one
   * case this rule exists for was the one case it got wrong.
   */
  const known = [...db.accounts, ...(db.settings.plaidItems ?? [])];
  const mine = error
    ? Boolean(noteFor(account, [error])) || !namesABank(known, error)
    : false;
  if (error && mine) return { state: "attention", provider, lastAt, status: "Needs attention", detail: error };

  if (!lastAt) return { state: "stale", provider, status: "Waiting for its first update" };

  // Answering, and bringing nothing. This is the one the other checks all
  // miss: the bridge returns the account every morning with a fresh balance
  // and an empty list of transactions, so the clock above reads "just now"
  // and every signal says connected while the newest transaction sits three
  // weeks back. A bank being upgraded at the far end looks exactly like this.
  //
  // Judged against this account's own rhythm, so a current account used daily
  // is asked after a few days and a savings account touched twice a year is
  // left alone.
  const quiet = quietFor(
    db.transactions.filter((t) => t.accountId === account.id).map((t) => t.date),
    now,
  );
  if (quiet) {
    return {
      state: "stale", provider, lastAt,
      status: "No new transactions",
      detail: `The balance is still arriving, but nothing has come through since ${quiet.since}. `
        + `That is ${quiet.days} days, against a usual gap of ${quiet.usual}. `
        + "A connection being upgraded or a login that needs renewing at the bank looks like this.",
    };
  }

  const hours = cadenceHours(db.settings.syncCadence ?? DEFAULT_CADENCE);
  // A cadence with no clock has no schedule to be behind, so only a provider
  // error can fault it. Two of them qualify: "off" is null, and "whenever I
  // open the app" is zero hours — which, multiplied out, makes every account
  // overdue by any elapsed time at all.
  if (hours !== null && hours > 0) {
    const behind = (now - new Date(lastAt).getTime()) / 3_600_000;
    if (Number.isFinite(behind) && behind > hours * MISSES) {
      return { state: "stale", provider, lastAt, status: "Not updating" };
    }
  }

  return { state: "connected", provider, lastAt, status: "Institution connected" };
}
