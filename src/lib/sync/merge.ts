import type { DB, Holding, Transaction } from "../../types.js";
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
    if (!accountId) continue;
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

/** Suggested start date for the next pull: 90 days back, or the last sync. */
export function syncWindowStart(db: DB): string {
  const last = db.settings.lastSyncAt ? db.settings.lastSyncAt.slice(0, 10) : null;
  const ninety = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  if (!last) return ninety;
  const backfill = new Date(Date.parse(last) - 14 * 86400000).toISOString().slice(0, 10);
  return backfill > ninety ? backfill : ninety;
}

