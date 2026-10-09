import type { DB } from "../../types.js";
import type { QueuedPull } from "../cloud.js";
import { ackQueued, push, queued } from "../cloud.js";
import { vault } from "../vault.js";
import type { QueuedPayload } from "./types.js";
import { openFrom } from "../crypto.js";
import { mergeSync } from "./merge.js";
import { noteRun } from "../usage.js";
import { SIMPLEFIN_ID } from "./simplefin.js";

/**
 * Merging in what the scheduled job pulled while nobody was looking.
 *
 * The job cannot write into an encrypted document, so it leaves each overnight
 * pull in a queue, encrypted to this installation's public key. This is the
 * only place those rows can be opened: it runs in the browser, with the private
 * key the passphrase unwrapped.
 *
 * Applied oldest first so a week away lands in the order it happened, and every
 * row goes through the same merge a live sync uses — the scheduled path and the
 * hands-on one cannot drift apart, because there is only one of them.
 */

export interface Drained {
  db: DB;
  /** Rows safely merged, to be dropped only once the result has been saved. */
  ids: number[];
  transactionsAdded: number;
  accountsUpdated: number;
  accountsAdded: number;
  /** Positions refreshed, which only a Plaid pull carries. */
  holdingsUpdated: number;
  /**
   * Rows that would not open. Left in place rather than deleted: they cost a
   * failed decrypt per poll and expire on their own, which is a better trade
   * than throwing away something that might yet be readable.
   */
  unreadable: number;
  /**
   * Rows opened and thrown away: a provider that is gone, or a connection this
   * document no longer holds. Counted rather than merged, so a pull that puts
   * nothing back is still visible as something that happened.
   */
  dropped: number;
  /** Rows that carried a failure rather than figures, and were written down. */
  noted: number;
}

export async function applyQueue(db: DB, rows: QueuedPull[], priv: CryptoKey): Promise<Drained> {
  const out: Drained = {
    db, ids: [], transactionsAdded: 0, accountsUpdated: 0, accountsAdded: 0, holdingsUpdated: 0,
    unreadable: 0, dropped: 0, noted: 0,
  };

  /**
   * The connections this document actually holds.
   *
   * On a sealed document the job cannot read the document, so it pulls from
   * whatever `PLAID_ACCESS_TOKENS` lists in the server environment. That list
   * is not something the app can edit: disconnecting a bank here removes the
   * item and hands the token back, but if Plaid refuses the hand-back the
   * token stays live and the environment still names it, and the job goes on
   * queueing that bank's accounts every night. Draining one would put them
   * back, which is the exact shape of the failure that cost a household its
   * data with the provider before this one.
   *
   * So the browser, which is the only thing that can read the document and the
   * last gate before anything is written, checks. A pull is applied only when
   * it names a connection that is still here.
   */
  const live = new Set<string>([
    ...(db.settings.plaidItems ?? []).map((i) => i.itemId),
    // The bridge is one connection behind one id, so a document that holds it
    // at all holds the only id its pulls can name. Disconnecting it drops the
    // settings, which takes the id out of this set, which is what stops the
    // job's queued pulls from putting those accounts back.
    ...(db.settings.simplefin?.accessUrl ? [SIMPLEFIN_ID] : []),
  ]);

  // A queued pull is the scheduled job's signature: on an encrypted document
  // the job cannot write settings, so this is the only place its run can be
  // recorded. Stamped once, from the pull that arrived rather than from now.
  if (rows.length) out.db = { ...out.db, settings: { ...out.db.settings, usage: noteRun(out.db.settings.usage, "vercel", "month", {}) } };

  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    let payload: QueuedPayload;
    try {
      payload = JSON.parse(await openFrom(priv, row)) as QueuedPayload;
    } catch {
      out.unreadable += 1;
      continue;
    }
    // A pull from a provider this app does not run is dropped, not merged. The
    // queue can still be holding payloads sealed by the job before the
    // provider they came from was retired, and merging one would put its
    // accounts back exactly the way the schedule used to. The row is claimed
    // so it stops being retried.
    //
    // And a pull has to name a connection this document still holds. A payload
    // that names none cannot be attributed to anything the household asked
    // for, which includes one whose item could not be identified at all, so it
    // is thrown away rather than merged on the chance that it is wanted.
    const source = payload.source;
    // A pull that failed outright brought no accounts to be named by, so it
    // says which connection it is about instead.
    const from = [
      ...payload.accounts.map((a) => a.itemId).filter(Boolean) as string[],
      ...(payload.itemId ? [payload.itemId] : []),
    ];
    if ((source !== "plaid" && source !== "simplefin") || !from.some((id) => live.has(id))) {
      out.ids.push(row.id);
      out.dropped += 1;
      continue;
    }

    // A pull that brought nothing at all and said why is a failed connection.
    // One that brought figures is a working connection, whatever it also
    // remarked on: those remarks belong on the accounts they name, which is
    // the merge's job, not a reason to call the login broken. The same rule
    // the browser's own sync follows, because a connection cannot be healthy
    // on one path and failing on the other.
    const failed = !payload.accounts.length && !payload.transactions.length && payload.errors.length > 0;

    // Recorded on the connection itself, so a bank whose name no account
    // matched still shows red in Settings and still raises the notice that
    // says to reconnect it.
    out.db = recordTrouble(out.db, source, from, failed ? payload.errors[0] : undefined, payload.fetchedAt);

    // Merging a failed pull would stamp its accounts as freshly synced and
    // move the document's own sync clock forward, which is the one thing that
    // must not happen: the staleness every other warning is built on would be
    // reset by the failure it is supposed to report, and the next pull would
    // ask for a window that had already been declared covered.
    if (!payload.accounts.length && !payload.transactions.length) {
      out.ids.push(row.id);
      out.noted += failed ? 1 : 0;
      continue;
    }

    const merged = mergeSync(out.db, payload, source);
    out.db = merged.db;
    out.ids.push(row.id);
    out.transactionsAdded += merged.transactionsAdded;
    out.accountsUpdated += merged.accountsUpdated;
    out.accountsAdded += merged.accountsAdded;
    out.holdingsUpdated += merged.holdingsUpdated;
  }
  return out;
}

/**
 * The connection's own last word, kept beside it.
 *
 * `mergeSync` puts a message naming a bank onto that bank's accounts, which is
 * where somebody looks first. This is the other half: the connection records
 * that it failed and when, so a message naming no bank at all still turns the
 * row red in Settings and still raises the notice that says to reconnect.
 *
 * Only a payload newer than what is already recorded may change it. The queue
 * is drained oldest first and holds last night's work, so without that rule a
 * stale success would rub out an error the browser recorded this morning.
 */
function recordTrouble(
  db: DB,
  source: "plaid" | "simplefin",
  ids: readonly string[],
  said: string | undefined,
  at: string,
): DB {
  const fresh = (held?: { at: string }): boolean => !held || held.at < at;

  if (source === "simplefin") {
    const bridge = db.settings.simplefin;
    if (!bridge || !fresh(bridge.lastError)) return db;
    if (!said && !bridge.lastError) return db;
    return {
      ...db,
      settings: {
        ...db.settings,
        simplefin: { ...bridge, lastError: said ? { message: said, at } : undefined },
      },
    };
  }

  const items = db.settings.plaidItems ?? [];
  const named = new Set(ids);
  let touched = false;
  const next = items.map((i) => {
    if (!named.has(i.itemId) || !fresh(i.lastError)) return i;
    if (!said && !i.lastError) return i;
    touched = true;
    return { ...i, lastError: said ? { message: said, at } : undefined };
  });
  return touched ? { ...db, settings: { ...db.settings, plaidItems: next } } : db;
}

/** "3 new transactions from the overnight sync." — or nothing worth saying. */
export function drainSummary(d: Drained): string | null {
  if (!d.ids.length) return null;
  const bits: string[] = [];
  if (d.transactionsAdded) {
    bits.push(`${d.transactionsAdded} new transaction${d.transactionsAdded === 1 ? "" : "s"}`);
  }
  const accounts = d.accountsAdded + d.accountsUpdated;
  if (accounts) bits.push(`${accounts} account${accounts === 1 ? "" : "s"}`);
  if (d.holdingsUpdated) bits.push(`${d.holdingsUpdated} holding${d.holdingsUpdated === 1 ? "" : "s"}`);
  if (!bits.length) return null;
  return `${bits.join(", ")} from the overnight sync.`;
}

/**
 * Fetch the queue, merge it, save the result, then acknowledge.
 *
 * The order is the point. Saving before acknowledging means a failure in
 * between leaves the rows to be applied again — which the merge is idempotent
 * about, since every transaction carries the provider's own id. Acknowledging
 * first would lose them.
 */
export async function drainQueue(
  current: DB,
  version: number,
): Promise<{ db: DB; version: number; said: string | null } | null> {
  const at = vault();
  if (!at) return null;
  const rows = await queued().catch(() => []);
  if (!rows.length) return null;

  const out = await applyQueue(current, rows, at.priv);
  if (!out.ids.length) return null;

  const saved = await push(out.db, version);
  await ackQueued(out.ids).catch(() => { /* they will simply be applied again */ });
  return { db: out.db, version: saved.version, said: drainSummary(out) };
}
