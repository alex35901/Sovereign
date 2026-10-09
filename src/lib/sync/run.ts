import type { DB, PlaidItemRef } from "../../types";
import { mergeSync, skipNotes, windowFor } from "./merge";
import { fetchInstitution, fetchItem, needsInstitution } from "./plaid";
import { fetchBridge } from "./simplefin";
import { reason, recordRun } from "../usage";
import { syncDue } from "./schedule";
import type { SyncCadence } from "./schedule";

export interface SyncOutcome {
  summary: string;
  errors: string[];
  /**
   * What the pull did that nobody asked about but everybody would want to
   * know: rows it left out, and accounts that shadow each other. Not errors,
   * and not worth colouring red, but never worth swallowing either.
   */
  notes: string[];
  /** Whether anything actually landed — the scheduler stays quiet when nothing did. */
  changed: boolean;
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
 * One Plaid item, merged in. Lives here rather than in the card that used to
 * own it, because two screens now offer to run it and two copies of this
 * would drift.
 */
export async function syncPlaidItem(
  apply: (fn: (cur: DB) => DB, label?: string, opts?: { quiet?: boolean }) => void,
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
  let notes: string[] = [];
  apply((cur) => {
    const res = mergeSync(cur, payload, "plaid");
    // What the merge skipped, plus whatever the pull itself wanted on the
    // record without calling it a fault. Both belong in the same place: the
    // card says them, and neither makes the provider read as down.
    notes = [...skipNotes(res), ...(payload!.notes ?? [])];
    const accounts = res.accountsAdded + res.accountsUpdated;
    summary =
      `${item.institution}: ${res.transactionsAdded} new transaction${res.transactionsAdded === 1 ? "" : "s"}` +
      `, ${accounts} account${accounts === 1 ? "" : "s"}` +
      (res.holdingsUpdated ? `, ${res.holdingsUpdated} holdings` : "");
    changed = res.transactionsAdded > 0 || res.accountsAdded > 0 || res.holdingsUpdated > 0;
    const stamped = (cur.settings.plaidItems ?? []).map((i) =>
      // A pull that worked clears whatever the last one said, and records what
      // this one quietly did not file. Both are replaced outright rather than
      // added to: they describe the last pull, not every pull there has been.
      (i.itemId === item.itemId
        ? {
          ...i, ...item,
          lastSyncAt: payload!.fetchedAt,
          lastError: undefined,
          lastNotes: notes.length ? { notes, at: payload!.fetchedAt } : undefined,
        }
        : i));
    return { ...res.db, settings: { ...res.db.settings, plaidItems: stamped } };
    // Named for the History page but silent on screen. A refresh is something
    // the app did on its own, and a toast per bank with an Undo beside it
    // asked a question nobody had: thirteen institutions filled the screen
    // with offers to take back a sync, over the figures they had come to read.
  }, `sync ${item.institution}`, { quiet: true });

  return { summary, errors: payload.errors, changed, notes };
}

/**
 * Every connected Plaid item, one after another.
 *
 * An item that fails does not stop the rest: a login that has expired at one
 * bank should not cost the other four their sync.
 */
export async function syncPlaid(
  db: DB,
  apply: (fn: (cur: DB) => DB, label?: string, opts?: { quiet?: boolean }) => void,
): Promise<SyncOutcome> {
  const items = db.settings.plaidItems ?? [];
  if (!items.length) throw new Error("No Plaid accounts are connected.");
  return runItems(apply, items);
}

/**
 * The same thing on a schedule, for the items whose turn has come.
 *
 * Plaid used to refresh only when somebody pressed a button or when the
 * overnight job ran, so the cadence in Settings drove nothing it was named
 * for. Null when nothing is due, so the caller can tell "nothing to do" from
 * "did it and nothing came back".
 */
export async function syncPlaidDue(
  db: DB,
  apply: (fn: (cur: DB) => DB, label?: string, opts?: { quiet?: boolean }) => void,
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
  apply: (fn: (cur: DB) => DB, label?: string, opts?: { quiet?: boolean }) => void,
  items: readonly PlaidItemRef[],
): Promise<SyncOutcome> {
  const summaries: string[] = [];
  const errors: string[] = [];
  const notes: string[] = [];
  let changed = false;

  for (const item of items) {
    try {
      const out = await syncPlaidItem(apply, item);
      summaries.push(out.summary);
      errors.push(...out.errors);
      notes.push(...out.notes);
      changed = changed || out.changed;
    } catch (err) {
      errors.push(`${item.institution}: ${reason(err, "the sync failed")}`);
    }
  }

  // Recorded once for the run rather than once per item, or the last bank to
  // succeed would clear the expired login of the first and the table would
  // call the whole thing healthy.
  recordRun(apply, "plaid", "ever", { error: errors[0] });

  return { summary: summaries.join(" · ") || "Nothing came back.", errors, changed, notes };
}

/* ── the bridge ───────────────────────────────────────────────────────── */

/**
 * The SimpleFIN bridge, merged in.
 *
 * One connection holding every bank the household authorised, so unlike Plaid
 * there is nothing to loop over: one pull, one window, one clock.
 *
 * The pull that used to live here was removed for a reason worth keeping in
 * view. It ran on the strength of an access URL sitting in the document, which
 * meant a bridge nobody had used for months could refill the app with the
 * accounts it once fed, unattended, over the top of what was there, and
 * restoring a backup from before the credential was removed brought the
 * credential back with it. What changed is that disconnecting now takes the
 * whole connection out rather than blanking a string, and nothing here reads
 * anything else: no connection, no pull. A backup holding a live connection
 * pulls again, which is what a backup holding a live Plaid item does too.
 */
export async function syncSimplefin(
  db: DB,
  apply: (fn: (cur: DB) => DB, label?: string, opts?: { quiet?: boolean }) => void,
  opts: { fullHistory?: boolean } = {},
): Promise<SyncOutcome> {
  const ref = db.settings.simplefin;
  if (!ref) throw new Error("No SimpleFIN bridge is connected.");

  let payload;
  try {
    payload = await fetchBridge(
      ref,
      windowFor(opts.fullHistory ? undefined : ref.lastSyncAt),
      new Date().toISOString().slice(0, 10),
    );
  } catch (err) {
    const message = reason(err, "the sync failed");
    recordRun(apply, "simplefin", "ever", { error: message });
    // Kept on the connection as well as in the meter, so the card for the
    // bridge can say what happened and offer the one repair there is.
    apply((cur) => (cur.settings.simplefin
      ? {
        ...cur,
        settings: {
          ...cur.settings,
          simplefin: { ...cur.settings.simplefin!, lastError: { message, at: new Date().toISOString() } },
        },
      }
      : cur));
    throw err;
  }

  let summary = "";
  let changed = false;
  let notes: string[] = [];
  apply((cur) => {
    const res = mergeSync(cur, payload, "simplefin");
    // What the merge skipped, plus whatever the pull itself wanted on the
    // record without calling it a fault. Both belong in the same place: the
    // card says them, and neither makes the provider read as down.
    notes = [...skipNotes(res), ...(payload!.notes ?? [])];
    const accounts = res.accountsAdded + res.accountsUpdated;
    summary = `${res.transactionsAdded} new transaction${res.transactionsAdded === 1 ? "" : "s"}`
      + `, ${accounts} account${accounts === 1 ? "" : "s"}`;
    changed = res.transactionsAdded > 0 || res.accountsAdded > 0;
    return res.db.settings.simplefin
      ? {
        ...res.db,
        settings: {
          ...res.db.settings,
          simplefin: {
            ...res.db.settings.simplefin!,
            lastSyncAt: payload!.fetchedAt,
            lastError: undefined,
          },
        },
      }
      : res.db;
    // Silent for the same reason as the Plaid pull above.
  }, "sync SimpleFIN", { quiet: true });

  recordRun(apply, "simplefin", "ever", { error: payload.errors[0] });
  return { summary, errors: payload.errors, changed, notes };
}

/** The same thing on a schedule, when its turn has come. */
export async function syncSimplefinDue(
  db: DB,
  apply: (fn: (cur: DB) => DB, label?: string, opts?: { quiet?: boolean }) => void,
  cadence: SyncCadence,
  now: number,
  sessionStart: number,
): Promise<SyncOutcome | null> {
  const ref = db.settings.simplefin;
  if (!ref || !syncDue(cadence, ref.lastSyncAt, now, sessionStart)) return null;
  return syncSimplefin(db, apply);
}
