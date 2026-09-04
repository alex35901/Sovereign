import type { DB } from "../../types";
import { simplefin } from "./simplefin";
import { mergeSync, syncWindowStart } from "./merge";
import { reason, recordRun } from "../usage";

export interface SyncOutcome {
  summary: string;
  errors: string[];
  /** Whether anything actually landed — the scheduler stays quiet when nothing did. */
  changed: boolean;
}

/**
 * One SimpleFIN pull, merged in. Shared by the Sync now button and the
 * scheduler so the two can't drift apart.
 */
export async function syncSimplefin(
  db: DB,
  apply: (fn: (cur: DB) => DB, label?: string) => void,
): Promise<SyncOutcome> {
  const accessUrl = db.settings.simplefinAccessUrl;
  if (!accessUrl) throw new Error("SimpleFIN isn't connected.");

  let payload;
  try {
    payload = await simplefin.fetch(accessUrl, syncWindowStart(db));
  } catch (err) {
    // The integrations table is the one place a failed background pull is
    // visible; the schedule itself deliberately says nothing.
    recordRun(apply, "simplefin", "ever", { error: reason(err, "The pull failed.") });
    throw err;
  }
  let summary = "";
  let changed = false;
  apply((cur) => {
    const res = mergeSync(cur, payload, "simplefin");
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    summary =
      `${plural(res.transactionsAdded, "new transaction")}, ` +
      `${plural(res.accountsUpdated, "account")} updated` +
      (res.accountsAdded ? `, ${res.accountsAdded} added` : "");
    // accountsUpdated counts every account the pull touched, not the ones that
    // moved, so a balance comparison is what tells us anything actually landed.
    const before = new Map(cur.accounts.map((a) => [a.id, a.balance]));
    changed =
      res.transactionsAdded > 0 ||
      res.accountsAdded > 0 ||
      res.db.accounts.some((a) => before.has(a.id) && before.get(a.id) !== a.balance);
    return res.db;
  }, "sync from SimpleFIN");

  // A pull that came back at all clears the last error, even when the bridge
  // reported trouble with an individual bank: those are named separately.
  recordRun(apply, "simplefin", "ever", { error: payload.errors[0] });

  return { summary, errors: payload.errors, changed };
}
