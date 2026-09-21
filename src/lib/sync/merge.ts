import type { DB, Holding, ISODate, Transaction } from "../../types.js";
import { noteFor } from "./notes.js";
import type { SyncPayload } from "./types.js";
import type { RemoteHolding } from "./plaid.js";
import { UNCATEGORIZED } from "../categories.js";
import { uid } from "../id.js";
import { applyRules } from "../rules.js";
import { added, record } from "../activity.js";
import { compressPoints } from "../history.js";


export interface MergeResult {
  db: DB;
  accountsAdded: number;
  accountsUpdated: number;
  transactionsAdded: number;
  /** Pending rows the provider has since restated or settled. */
  transactionsRevised: number;
  holdingsUpdated: number;
  /**
   * Rows the provider sent that did not become transactions, and why.
   *
   * Every one of these used to be a bare `continue`. A pull would report "0
   * new transactions" while quietly dropping a fortnight of them, and there
   * was no way at all to tell that apart from a bank with nothing to send.
   */
  skipped: {
    /** Named an account this document does not track, or no longer does. */
    noAccount: number;
    /** Older than the day the account was told to start taking history from. */
    beforeFloor: number;
    /** Which accounts those were, and from what day, for a sentence about it. */
    floors: { name: string; from: ISODate; count: number }[];
  };
  /** Rows recognised as something already held, under an id that changed. */
  rekeyed: number;
  /**
   * Accounts that claim the same provider account as another one.
   *
   * Only the first of them is ever fed, so the others go quiet for ever while
   * the connection reports itself healthy. It happens when an account is moved
   * onto a connection that had already made its own copy of it.
   */
  sharedIds: string[];
}

/**
 * Folds a provider payload into the database: accounts are matched on syncId,
 * transactions de-duplicated on the provider's own transaction id, and every
 * new transaction is run through the rules engine before it lands.
 */
export function mergeSync(
  db: DB,
  payload: SyncPayload & { holdings?: RemoteHolding[] },
  source: "simplefin" | "plaid",
): MergeResult {
  const accounts = [...db.accounts];
  let accountsAdded = 0;
  let accountsUpdated = 0;
  const idBySyncId = new Map<string, string>();

  const tombstones = new Set(db.settings.deletedAccountKeys ?? []);

  for (const r of payload.accounts) {
    // Deleted on purpose: skip it entirely, so it neither returns as a new
    // account nor brings its transactions with it.
    if (accountKeys({ syncId: r.syncId, name: r.name, institution: r.institution }).some((k) => tombstones.has(k))) continue;

    const existing = accounts.find((a) => a.syncId === r.syncId)
      ?? accounts.find((a) => a.syncSource === source && a.name === r.name && a.institution === r.institution);

    // A closed account has been settled deliberately. Leave its balance and
    // history alone, and take no further transactions for it.
    if (existing?.closedAt) continue;

    if (existing) {
      const history = existing.history.filter((h) => h.date !== r.balanceDate);
      history.push({ date: r.balanceDate, balance: r.balance });
      history.sort((a, b) => (a.date < b.date ? -1 : 1));
      // Squashed on the way in, or a daily pull writes the same figure again
      // every morning for every account that has not moved — and the document
      // is uploaded whole on every save. See lib/history.ts.
      const kept = compressPoints(history);
      const idx = accounts.indexOf(existing);
      accounts[idx] = {
        ...existing, balance: r.balance, history: kept,
        syncId: r.syncId, syncSource: source, lastSyncedAt: payload.fetchedAt,
        // Whatever the provider said about this one last time, said again or
        // dropped. An account that came back clean is clean.
        syncNote: noteFor(existing, payload.errors)
          ? { message: noteFor(existing, payload.errors)!, at: payload.fetchedAt }
          : undefined,
        // Refreshed on every pull, but never blanked: a provider that stops
        // sending one shouldn't lose the logo already held.
        logo: r.logo ?? existing.logo,
        domain: r.domain ?? existing.domain,
      };
      idBySyncId.set(r.syncId, existing.id);
      accountsUpdated++;
    } else {
      const id = uid("a");
      accounts.push({
        id, name: r.name, institution: r.institution, type: r.type,
        balance: r.balance, includeInNetWorth: true, hidden: false,
        logo: r.logo, domain: r.domain,
        history: [{ date: r.balanceDate, balance: r.balance }],
        syncSource: source, syncId: r.syncId, lastSyncedAt: payload.fetchedAt,
        order: accounts.length,
      });
      idBySyncId.set(r.syncId, id);
      accountsAdded++;
    }
  }

  // The accounts this provider feeds that the pull did not bring back at all.
  // A bank being upgraded or needing a new login goes quiet rather than
  // failing, so the message naming it arrives with no account attached to it.
  if (payload.errors.length) {
    const returned = new Set(payload.accounts.map((r) => r.syncId));
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i]!;
      if (a.syncSource !== source || a.closedAt) continue;
      if (a.syncId && returned.has(a.syncId)) continue;
      const said = noteFor(a, payload.errors);
      if (said) accounts[i] = { ...a, syncNote: { message: said, at: payload.fetchedAt } };
    }
  }

  // Two accounts claiming one provider account: only the first is ever found,
  // so the rest go quiet while the connection calls itself healthy.
  const seenSyncIds = new Map<string, string>();
  const sharedIds: string[] = [];
  for (const a of accounts) {
    if (!a.syncId || a.closedAt) continue;
    const first = seenSyncIds.get(a.syncId);
    if (first) sharedIds.push(`${first} and ${a.name}`);
    else seenSyncIds.set(a.syncId, a.name);
  }

  let skippedNoAccount = 0;
  const floorCounts = new Map<string, { name: string; from: ISODate; count: number }>();

  const prefix = source === "plaid" ? "pl" : "sf";
  const keyFor = (syncId: string) => `${prefix}:${syncId}`;
  const known = new Set(db.transactions.map((t) => t.importKey).filter(Boolean) as string[]);
  // By key, so a row the provider has restated can be found and corrected
  // rather than merely recognised and skipped.
  const heldByKey = new Map<string, Transaction>();
  for (const t of db.transactions) if (t.importKey) heldByKey.set(t.importKey, t);

  /** Rows the provider has revised, by id. Applied after the walk. */
  const revised = new Map<string, Partial<Transaction>>();

  /**
   * Holds this same pull says have already settled.
   *
   * A pull covers a window, so it routinely carries both the hold and the
   * charge it became. Whichever order they arrive in, the hold is not worth
   * adding: the payload has already said what became of it.
   */
  const supersededHere = new Set<string>();
  for (const r of payload.transactions) if (r.replacesSyncId) supersededHere.add(r.replacesSyncId);

  /**
   * The stored rows by key, rekeyed as replacements are worked out.
   *
   * Only ever rows the document already had. A row arriving in this same pull
   * can never be the thing a later row replaces: the pass above has already
   * skipped any hold this payload supersedes, so by the time a settled row is
   * looked at, the hold it names is either something stored or nothing at all.
   */
  const byKey = new Map<string, Transaction>(heldByKey);

  /**
   * The same transaction, arriving under an id it did not have before.
   *
   * A connection remade at the bank is a new Plaid item, and a new item mints
   * a new id for every transaction in it. Nothing recognised them, so a
   * remake filed a second copy of everything already held, with the
   * categories and notes on the first copy and the provider's attention on
   * the second. That is the cost that stopped a connection being remade, and
   * remaking it is the only way to widen the history of some banks.
   *
   * Matched on the account, the day and the amount, and claimed rather than
   * merely found: two five dollar coffees on one Tuesday are two rows, and
   * each incoming one takes a different stored one.
   *
   * Only rows this payload has not already named by id are eligible, which is
   * what keeps an ordinary sync out of this entirely. A provider sends its
   * whole window every time, so everything inside it is spoken for and the
   * only rows left here are older than anything arriving. A genuinely new
   * transaction cannot match one of those, because it is not old enough.
   */
  const restated = new Set<string>();
  for (const r of payload.transactions) {
    restated.add(keyFor(r.syncId));
    if (r.replacesSyncId) restated.add(keyFor(r.replacesSyncId));
  }
  const twinKey = (accountId: string, date: string, amount: number) => `${accountId}|${date}|${amount}`;
  const twins = new Map<string, Transaction[]>();
  for (const t of db.transactions) {
    if (!t.importKey || restated.has(t.importKey)) continue;
    const k = twinKey(t.accountId, t.date, t.amount);
    const held = twins.get(k);
    if (held) held.push(t);
    else twins.set(k, [t]);
  }
  let rekeyed = 0;

  /** The oldest unclaimed stored row for this day and figure, if there is one. */
  const claimTwin = (accountId: string, date: string, amount: number): Transaction | undefined =>
    twins.get(twinKey(accountId, date, amount))?.shift();

  const fresh: Transaction[] = [];
  for (const r of payload.transactions) {
    const key = keyFor(r.syncId);

    // Superseded inside this very pull, and not something already held. The
    // settled row in this same payload stands for it.
    if (r.pending && supersededHere.has(r.syncId) && !byKey.has(key)) continue;

    /**
     * A pending charge is provisional; a settled one is a fact.
     *
     * Nothing here ever looked at a transaction it already had, so a hold
     * stayed pending for ever and kept the figure it was held at. A fuel hold
     * of fifty dollars that settles at seventy-one sat in the account at fifty
     * until somebody noticed and typed over it.
     *
     * Only while the stored row is still pending, and only the things the
     * provider owns: the amount, the day, the statement line and whether it
     * has settled. The merchant, the category, the tags, the notes and the
     * books are the household's, and a sync does not get to rewrite those. A
     * row that has already settled is left alone entirely - a provider
     * restating last March is not something to take on trust.
     */
    const heldSame = byKey.get(key);
    if (heldSame) {
      if (heldSame.pending) {
        const patch: Partial<Transaction> = {};
        if (heldSame.amount !== r.amount) patch.amount = r.amount;
        if (heldSame.date !== r.date) patch.date = r.date;
        if (heldSame.statement !== r.description) patch.statement = r.description;
        if (heldSame.pending !== r.pending) patch.pending = r.pending;
        if (Object.keys(patch).length) revised.set(heldSame.id, patch);
      }
      continue;
    }

    // Plaid gives a settled charge a new id and names the pending one it
    // replaces. Without this the hold and the charge both stand.
    const oldKey = r.replacesSyncId ? keyFor(r.replacesSyncId) : undefined;
    const wasPending = oldKey ? byKey.get(oldKey) : undefined;
    if (oldKey && wasPending?.pending) {
      const patch: Partial<Transaction> = {
        amount: r.amount, date: r.date, statement: r.description,
        pending: r.pending, importKey: key,
      };
      revised.set(wasPending.id, patch);
      byKey.delete(oldKey);
      byKey.set(key, { ...wasPending, ...patch });
      known.add(key);
      continue;
    }

    if (known.has(key)) continue;
    const accountId = idBySyncId.get(r.accountSyncId);
    if (!accountId) { skippedNoAccount += 1; continue; }

    // Held already, under the id it had before the connection was remade.
    // Re-keyed rather than added, so the household keeps the category, the
    // notes and the tags it put on it, and the provider keeps track of it.
    const twin = claimTwin(accountId, r.date, r.amount);
    if (twin) {
      revised.set(twin.id, {
        importKey: key,
        // A hold that settled while the connection was being remade.
        ...(twin.pending && !r.pending ? { pending: false, statement: r.description } : {}),
      });
      known.add(key);
      rekeyed += 1;
      continue;
    }

    // An account moved from one provider to another already holds its older
    // history, under the other provider's ids. Taking the backfill as well
    // would file a second copy of all of it.
    const held = accounts.find((a) => a.id === accountId);
    const floor = held?.syncFrom;
    if (floor && r.date < floor) {
      const at = floorCounts.get(accountId)
        ?? { name: held?.name ?? "an account", from: floor, count: 0 };
      at.count += 1;
      floorCounts.set(accountId, at);
      continue;
    }
    known.add(key);
    const base: Transaction = {
      id: uid("t"),
      accountId,
      date: r.date,
      merchant: cleanMerchant(r.payee || r.description),
      statement: r.description,
      amount: r.amount,
      categoryId: UNCATEGORIZED,
      notes: r.memo || undefined,
      tags: [],
      pending: r.pending,
      reviewed: false,
      hideFromReports: false,
      importKey: key,
      createdAt: payload.fetchedAt,
      activity: [added(source, payload.fetchedAt)],
    };
    // Rules run on arrival; whatever they change is logged like any other edit.
    fresh.push(record(db, base, applyRules(db.rules, base), payload.fetchedAt));
  }

  const carried = revised.size
    ? db.transactions.map((t) => {
      const patch = revised.get(t.id);
      // Logged like any other change, so a figure that moved under somebody
      // is something they can see happened rather than something they
      // misremember typing.
      return patch ? record(db, t, { ...t, ...patch }, payload.fetchedAt) : t;
    })
    : db.transactions;

  const transactions = [...fresh, ...carried].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // Holdings are a snapshot, not a ledger: whatever the provider reports for an
  // account replaces what was there, so a sold position disappears instead of
  // lingering at its last known price.
  let holdings = db.holdings;
  let holdingsUpdated = 0;
  if (payload.holdings?.length) {
    const touched = new Set<string>();
    const incoming: Holding[] = [];
    for (const h of payload.holdings) {
      const accountId = idBySyncId.get(h.accountSyncId);
      if (!accountId) continue;
      touched.add(accountId);
      incoming.push({
        id: uid("h"),
        accountId,
        ticker: h.ticker,
        name: h.name,
        quantity: h.quantity,
        costBasis: h.costBasis,
        price: h.price,
        assetClass: h.assetClass,
        securityType: h.securityType,
      });
    }
    if (touched.size) {
      holdings = [...db.holdings.filter((h) => !touched.has(h.accountId)), ...incoming];
      holdingsUpdated = incoming.length;
    }
  }

  return {
    db: {
      ...db, accounts, transactions, holdings,
      settings: { ...db.settings, lastSyncAt: payload.fetchedAt },
    },
    accountsAdded, accountsUpdated, transactionsAdded: fresh.length,
    transactionsRevised: revised.size, holdingsUpdated,
    skipped: {
      noAccount: skippedNoAccount,
      beforeFloor: [...floorCounts.values()].reduce((n, f) => n + f.count, 0),
      floors: [...floorCounts.values()],
    },
    rekeyed,
    sharedIds,
  };
}

/**
 * The identities a provider might hand an account back under: its own stable id,
 * and the name/institution pair the merge falls back to before one is known.
 */
export function accountKeys(a: { syncId?: string; name: string; institution: string }): string[] {
  const keys = [`name:${a.institution.toLowerCase().trim()}|${a.name.toLowerCase().trim()}`];
  if (a.syncId) keys.unshift(`sync:${a.syncId}`);
  return keys;
}

/** Strips the noise banks staple onto descriptions: card numbers, store ids, dates. */
export function cleanMerchant(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/\b(?:pos|debit|credit|purchase|payment|ach|pmt|des:|id:|indn:|ppd|ccd|web)\b/gi, " ");
  s = s.replace(/\b[xX*#]{2,}\d{2,}\b/g, " ");
  s = s.replace(/\b\d{2}\/\d{2}(?:\/\d{2,4})?\b/g, " ");
  s = s.replace(/\b\d{4,}\b/g, " ");
  s = s.replace(/[#*]\s?\d+\b/g, " ");
  s = s.replace(/\s\d{2,3}$/, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return raw.trim() || "Unknown";
  return s
    .toLowerCase()
    .split(" ")
    // short tokens are usually initialisms (SQ, SF, ATM); otherwise capitalise
    // the first letter, skipping punctuation like the "*" in "SQ *BLUE BOTTLE"
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w.replace(/[a-z]/, (ch) => ch.toUpperCase())))
    .join(" ");
}

/** As far back as Plaid keeps transactions, which is what a first pull wants. */
export const FIRST_PULL_DAYS = 730;
/** The ordinary window for a connection that has been running. */
const WINDOW_DAYS = 90;
/** Overlap on a repeat pull, so a transaction that posts late is still seen. */
const BACKFILL_DAYS = 14;

const daysAgo = (days: number, now: number): string =>
  new Date(now - days * 86400000).toISOString().slice(0, 10);

/**
 * How far back to ask a connection for.
 *
 * A connection that has never been pulled has no history here, so it is asked
 * for everything it has.
 *
 * One that has been running is asked from a fortnight before its own last
 * pull, which is overlap enough for a transaction that posts days after it
 * happened. Never from more than ninety days ago, though: a connection that
 * lapsed a year ago should not try to swallow the year in one request, and
 * the gap it left is what the full history button is for.
 *
 * Per connection, because the alternative was one window for the whole
 * document, taken from the SimpleFIN clock. A Plaid bank connected today was
 * handed the window of a SimpleFIN connection that had been syncing daily for
 * months, and got a fortnight of history where two years were available.
 */
export function windowFor(
  lastSyncAt: string | undefined,
  firstPullDays = FIRST_PULL_DAYS,
  now: number = Date.now(),
): string {
  if (!lastSyncAt) return daysAgo(firstPullDays, now);
  const last = Date.parse(lastSyncAt);
  if (!Number.isFinite(last)) return daysAgo(firstPullDays, now);
  const ordinary = daysAgo(WINDOW_DAYS, now);
  const backfill = new Date(last - BACKFILL_DAYS * 86400000).toISOString().slice(0, 10);
  return backfill > ordinary ? backfill : ordinary;
}

/**
 * The document-wide window, for the callers that have no one connection in
 * mind: the scheduled job, which pulls everything on one clock, and the line
 * in Settings that says when the next pull starts from.
 */
export function syncWindowStart(db: DB): string {
  return windowFor(db.settings.lastSyncAt, WINDOW_DAYS);
}


/**
 * What a pull quietly did not file, in plain words.
 *
 * "0 new transactions" is the same sentence whether the bank sent nothing or
 * whether it sent a fortnight that every one of the merge's rules threw away.
 * The household has no way to tell those apart, and the second one is the
 * failure that hides for weeks.
 */
export function skipNotes(res: MergeResult): string[] {
  const out: string[] = [];
  const rows = (n: number) => `${n} transaction${n === 1 ? "" : "s"}`;

  for (const f of res.skipped.floors) {
    out.push(
      `${f.name}: ${rows(f.count)} before ${f.from} were left out, because that is the day this `
      + "account was told to start taking history from when it moved to Plaid. Everything before it "
      + "is already here under the old connection.",
    );
  }
  if (res.skipped.noAccount) {
    out.push(
      `${rows(res.skipped.noAccount)} arrived for an account this document does not track. `
      + "That is an account deleted on purpose, or one not yet pointed at this connection.",
    );
  }
  for (const pair of res.sharedIds) {
    out.push(
      `${pair} both claim the same account at the bank. Only the first of them is fed, so the other `
      + "will go quiet while the connection still reports itself healthy. Delete the empty one, or "
      + "point it somewhere else.",
    );
  }
  return out;
}
