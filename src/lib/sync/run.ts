import type { DB, PlaidItemRef } from "../../types";
import { simplefin } from "./simplefin";
import { mergeSync, syncWindowStart, windowFor } from "./merge";
import { fetchInstitution, fetchItem, needsInstitution } from "./plaid";
import { reason, recordRun } from "../usage";
import { syncDue } from "./schedule";
import { unclaimed } from "./notes";
import type { SyncCadence } from "./schedule";

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

  // A pull that came back at all clears the last error. What the bridge said
  // about a named bank is now kept on that bank's own account, so only the
  // messages that named nobody are left to report against the connection as a
  // whole. Otherwise every account's status box would repeat one bank's
  // trouble as though it were everyone's.
  recordRun(apply, "simplefin", "ever", {
    error: unclaimed(db.accounts.filter((a) => a.syncSource === "simplefin"), payload.errors)[0],
  });

  return { summary, errors: payload.errors, changed };
}

/* ── plaid ────────────────────────────────────────────────────────────── */

/**
 * Fills in the institution's mark for an item connected before the app kept
 * one. Not worth failing a sync over — the initials still stand — and the
 * attempt is stamped either way so a logo-less bank isn't asked every time.
 */
async function withInstitution(item: PlaidItemRef): Promise<PlaidItemRef> {
  if (!needsInstitution(item)) return item;
  const asked = { ...item, institutionCheckedAt: new Date().toISOString() };
  try {
    const mark = await fetchInstitution(item.accessToken);
    return { ...asked, logo: mark.logo ?? item.logo, domain: mark.domain ?? item.domain };
  } catch {
    return asked;
  }
}

/**
 * One Plaid item, merged in. Lives here beside the SimpleFIN pull rather than
 * in the card that used to own it, because two screens now offer to run it and
 * two copies of this would drift.
 */
export async function syncPlaidItem(
  apply: (fn: (cur: DB) => DB, label?: string) => void,
  rawItem: PlaidItemRef,
  opts: { fullHistory?: boolean } = {},
): Promise<SyncOutcome> {
  const item = await withInstitution(rawItem);

  let payload;
  try {
    // This item's own clock, not the document's. The document's belongs to
    // whichever connection last ran, and a bank connected today was being
    // handed the narrow window of one that had been syncing for months.
    payload = await fetchItem(item, windowFor(opts.fullHistory ? undefined : item.lastSyncAt));
  } catch (err) {
    // Named, because a Plaid item whose login has expired fails silently on
    // every later sync and the integrations table is where that shows up.
    const message = reason(err, "the sync failed");
    recordRun(apply, "plaid", "ever", { error: `${item.institution}: ${message}` });
    // And kept on the item itself, so the row for this bank can offer to
    // reconnect it while the others are left alone.
    apply((cur) => ({
      ...cur,
      settings: {
        ...cur.settings,
        plaidItems: (cur.settings.plaidItems ?? []).map((i) =>
          i.itemId === item.itemId ? { ...i, lastError: { message, at: new Date().toISOString() } } : i),
      },
    }));
    throw err;
  }

  let summary = "";
  let changed = false;
  apply((cur) => {
    const res = mergeSync(cur, payload, "plaid");
    const accounts = res.accountsAdded + res.accountsUpdated;
    summary =
      `${item.institution}: ${res.transactionsAdded} new transaction${res.transactionsAdded === 1 ? "" : "s"}` +
      `, ${accounts} account${accounts === 1 ? "" : "s"}` +
      (res.holdingsUpdated ? `, ${res.holdingsUpdated} holdings` : "");
    changed = res.transactionsAdded > 0 || res.accountsAdded > 0 || res.holdingsUpdated > 0;
    const stamped = (cur.settings.plaidItems ?? []).map((i) =>
      // A pull that worked clears whatever the last one said.
      i.itemId === item.itemId ? { ...i, ...item, lastSyncAt: payload!.fetchedAt, lastError: undefined } : i);
    return { ...res.db, settings: { ...res.db.settings, plaidItems: stamped } };
  }, `sync ${item.institution}`);

  return { summary, errors: payload.errors, changed };
}

/**
 * Every connected Plaid item, one after another.
 *
 * An item that fails does not stop the rest: a login that has expired at one
 * bank should not cost the other four their sync.
 */
export async function syncPlaid(
  db: DB,
  apply: (fn: (cur: DB) => DB, label?: string) => void,
): Promise<SyncOutcome> {
  const items = db.settings.plaidItems ?? [];
  if (!items.length) throw new Error("No Plaid accounts are connected.");
  return runItems(apply, items);
}

/**
 * The same thing on a schedule, for the items whose turn has come.
 *
 * Plaid used to refresh only when somebody pressed a button or when the
 * overnight job ran, while SimpleFIN refreshed itself all day on the cadence
 * in Settings. Two banks connected two ways behaved differently for no reason
 * anyone chose. Null when nothing is due, so the caller can tell "nothing to
 * do" from "did it and nothing came back".
 */
export async function syncPlaidDue(
  db: DB,
  apply: (fn: (cur: DB) => DB, label?: string) => void,
  cadence: SyncCadence,
  now: number,
  sessionStart: number,
): Promise<SyncOutcome | null> {
  // Each item keeps its own clock, so a bank added this afternoon is not
  // treated as overdue because another one was last pulled this morning.
  const due = (db.settings.plaidItems ?? [])
    .filter((i) => syncDue(cadence, i.lastSyncAt, now, sessionStart));
  if (!due.length) return null;
  return runItems(apply, due);
}

async function runItems(
  apply: (fn: (cur: DB) => DB, label?: string) => void,
  items: readonly PlaidItemRef[],
): Promise<SyncOutcome> {
  const summaries: string[] = [];
  const errors: string[] = [];
  let changed = false;

  for (const item of items) {
    try {
      const out = await syncPlaidItem(apply, item);
      summaries.push(out.summary);
      errors.push(...out.errors);
      changed = changed || out.changed;
    } catch (err) {
      errors.push(`${item.institution}: ${reason(err, "the sync failed")}`);
    }
  }

  // Recorded once for the run rather than once per item, or the last bank to
  // succeed would clear the expired login of the first and the table would
  // call the whole thing healthy.
  recordRun(apply, "plaid", "ever", { error: errors[0] });

  return { summary: summaries.join(" · ") || "Nothing came back.", errors, changed };
}
