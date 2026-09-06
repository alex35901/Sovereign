import type { Account, DB } from "../types.js";
import { cadenceHours, DEFAULT_CADENCE } from "./sync/schedule.js";
import { meterOf } from "./usage.js";

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

  // The provider's own last word, which is what the Settings health column
  // reads. An error here is the whole institution, not just this account, and
  // it is cleared by the next run that comes back at all.
  const error = meterOf(db.settings.usage, source, "ever", now).error;
  if (error) return { state: "attention", provider, lastAt, status: "Needs attention", detail: error };

  if (!lastAt) return { state: "stale", provider, status: "Waiting for its first update" };

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
