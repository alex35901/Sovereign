import type { DB, Holding, Transaction } from "../../types.js";
import type { SyncPayload } from "./types.js";
import type { RemoteHolding } from "./plaid.js";
import { UNCATEGORIZED } from "../categories.js";
import { uid } from "../id.js";
import { applyRules } from "../rules.js";
import { added, record } from "../activity.js";


export interface MergeResult {
  db: DB;
  accountsAdded: number;
  accountsUpdated: number;
  transactionsAdded: number;
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
      const idx = accounts.indexOf(existing);
      accounts[idx] = {
        ...existing, balance: r.balance, history,
        syncId: r.syncId, syncSource: source, lastSyncedAt: payload.fetchedAt,
      };
      idBySyncId.set(r.syncId, existing.id);
      accountsUpdated++;
    } else {
      const id = uid("a");
      accounts.push({
        id, name: r.name, institution: r.institution, type: r.type,
        balance: r.balance, includeInNetWorth: true, hidden: false,
        history: [{ date: r.balanceDate, balance: r.balance }],
        syncSource: source, syncId: r.syncId, lastSyncedAt: payload.fetchedAt,
        order: accounts.length,
      });
      idBySyncId.set(r.syncId, id);
      accountsAdded++;
    }
  }

  const known = new Set(db.transactions.map((t) => t.importKey).filter(Boolean) as string[]);
  const fresh: Transaction[] = [];
  for (const r of payload.transactions) {
    const key = `${source === "plaid" ? "pl" : "sf"}:${r.syncId}`;
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

  const transactions = [...fresh, ...db.transactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

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
    accountsAdded, accountsUpdated, transactionsAdded: fresh.length, holdingsUpdated,
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

