import type { DB } from "../types";
import { buildDemoDB, emptyDB } from "./seed";
import { migrateGoalAccounts } from "./goal-funding.js";
import { addMonths, thisMonth } from "./date.js";
import { FUTURE_MONTHS } from "./select.js";

const KEY = "sovereign.db.v1";
/**
 * Which stored version the cached document is a copy of.
 *
 * Its own key, but written in the same breath as the document and only ever
 * after the document write has actually landed. That order is the whole point.
 *
 * These used to be the document here and the version number over in the cloud
 * state, written at different moments by different code. A phone ran out of
 * room for the document, the write threw, the failure went to console.error
 * and nowhere else, and every write after it threw too. The version number is
 * a hundred bytes and kept saving perfectly. So the cache froze at the last
 * size that fitted while the number went on counting, and the next load read
 * a document months old beside a number saying it was current. Nothing looked
 * wrong to the sync loop, and the first edit pushed that frozen copy over
 * everything since, at a version the server had no reason to refuse.
 *
 * Written this way they can still end up disagreeing, but only ever in the
 * direction that is safe: a document that failed to save leaves the stamp
 * behind with it, so the browser knows it cannot vouch for what it is holding
 * and goes to the server instead. The document itself keeps the shape it has
 * always had, which is what everything reading this cache from the outside
 * expects.
 */
const AT_KEY = "sovereign.db.at.v1";

export interface LoadedDB {
  db: DB;
  /**
   * What this copy is a version of, or null when it cannot say.
   *
   * Null for a cache written before the stamp existed, and for one whose write
   * failed part way. A browser that cannot say which version it holds must not
   * claim one: it reconciles from scratch and takes what the server has, which
   * costs one fetch and is the only answer that cannot lose anything.
   */
  at: number | null;
}

export function loadDB(): LoadedDB | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const at = Number(localStorage.getItem(AT_KEY));
    return {
      db: migrate(JSON.parse(raw) as DB),
      at: Number.isFinite(at) && at > 0 ? at : null,
    };
  } catch {
    return null;
  }
}

/**
 * Bare timer functions rather than `window`'s, so this module works anywhere.
 *
 * It used to reach through `window`, which meant the cache could only be
 * exercised in a browser — and the one thing that badly needed exercising was
 * what happens when the write fails, which is a test and not a browser.
 */
let writeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Whether the last attempt to cache the document actually landed.
 *
 * Read by the store, which stops claiming to know which version it holds the
 * moment this goes false. A browser that cannot write its copy down is a
 * browser whose copy is about to be wrong.
 */
let lastWriteOk = true;
export const cacheHealthy = (): boolean => lastWriteOk;

/**
 * What this browser is holding that is not the budget, least precious first.
 *
 * Everything here can be thrown away without losing anything the household
 * typed: the benchmark cache is prices that can be fetched again, and the
 * change log is the undo history, which is a convenience and not a record of
 * anything that is not already in the document.
 *
 * Two things are deliberately absent. The document itself, obviously. And the
 * conflict copy, which looks like an ordinary cache and is the opposite of
 * one: it is work that lost a race to another device and exists nowhere else.
 * Freeing room by deleting the one thing here that cannot be got back again
 * would be the same failure in a new coat.
 */
const SPARE_KEYS = ["sovereign.benchmarks.v1", "sovereign.changelog.v1"];

/**
 * Room made by giving up something that can be got again.
 *
 * @returns whether anything was actually freed, so the caller knows whether
 * trying again could possibly go any better.
 */
function freeRoom(): boolean {
  for (const key of SPARE_KEYS) {
    try {
      if (localStorage.getItem(key) === null) continue;
      localStorage.removeItem(key);
      return true;
    } catch { /* if even reading throws, there is nothing to be done here */ }
  }
  return false;
}

function write(db: DB, at: number): boolean {
  const once = (): boolean => {
    localStorage.setItem(KEY, JSON.stringify(db));
    // Only now, and only because the line above did not throw.
    localStorage.setItem(AT_KEY, String(at));
    return true;
  };

  try {
    once();
    lastWriteOk = true;
    return true;
  } catch (err) {
    /**
     * Out of room, which until now was the end of it.
     *
     * A browser that cannot write its copy down stays that way: every save
     * after this one fails for the same reason, the cache goes stale, and the
     * household finds out weeks later. It is how one of them lost months of
     * work. But the thing filling the room is often not the budget at all,
     * and the app is holding a megabyte of undo history and a cache of share
     * prices beside it, either of which can be given up without losing
     * anything. So give one up and try again, rather than reporting a
     * condition nobody can act on from inside the app.
     */
    while (freeRoom()) {
      try {
        once();
        lastWriteOk = true;
        return true;
      } catch { /* still too big: give up something else and try again */ }
    }

    // Nothing left to give up. The stamp goes rather than staying to vouch for
    // a document that may not have been written, which is the failure this
    // whole arrangement exists to stop.
    try { localStorage.removeItem(AT_KEY); } catch { /* nothing left to do */ }
    console.error("Could not cache the budget in this browser.", err);
    lastWriteOk = false;
    return false;
  }
}

/** Debounced — the reducer fires on every keystroke in an edit form. */
export function saveDB(db: DB, at: number): void {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => { write(db, at); }, 250);
}

export function saveNow(db: DB, at: number): boolean {
  clearTimeout(writeTimer);
  return write(db, at);
}

export function clearDB(): void {
  localStorage.removeItem(KEY);
  localStorage.removeItem(AT_KEY);
}

/**
 * Fill in fields added by later versions so old exports keep working.
 *
 * Exported because a document does not only arrive through localStorage. One
 * saved by another device comes down from the cloud and used to skip all of
 * this, so a browser on the new version could be handed the old shape and go
 * looking for fields that were not there. It survived only because the copy
 * went into storage and got migrated on the next load, which is luck rather
 * than design.
 *
 * Every step returns the document it was given when it has nothing to change,
 * so a document that is already current comes back as the very same object.
 * That is what lets a caller tell "this is exactly what the server holds" from
 * "this needed bringing up to date, and the server should be told".
 */
export function migrate(db: DB): DB {
  const base = emptyDB();
  let out = db;

  const settings = (out.settings ?? {}) as unknown as Record<string, unknown>;
  const missingField = (Object.keys(base) as (keyof DB)[]).some((k) => out[k] === undefined);
  const missingSetting = Object.keys(base.settings).some((k) => settings[k] === undefined);
  if (missingField || missingSetting) {
    out = { ...base, ...out, settings: { ...base.settings, ...out.settings } };
  }

  const transactions = out.transactions.map((t) => (t.tags ? t : { ...t, tags: [] }));
  if (transactions.some((t, i) => t !== out.transactions[i])) out = { ...out, transactions };

  const accounts = out.accounts.map((a) => (a.history ? a : { ...a, history: [] }));
  if (accounts.some((a, i) => a !== out.accounts[i])) out = { ...out, accounts };

  out = migrateBudgetDefaults(out);

  // Goals used to name whole accounts; they hold amounts now. Runs once — it
  // leaves a document that already has allocations alone.
  return migrateGoalAccounts(out);
}

/**
 * Turning a standing amount into the months it stood for.
 *
 * A category used to be able to hold one figure that applied from a month
 * onwards, and the budget sheet showed it wherever no explicit entry existed.
 * It was one rule with three separate ways of quietly rewriting months nobody
 * had touched — replacing one emptied the months it had covered, ending one
 * emptied them too, and unticking the box that set it emptied the future — and
 * every one of them turned up as a bug against real money.
 *
 * So there is no standing amount any more, only ordinary per-month figures.
 * This writes out what the old one was showing, from the month it started to
 * five years past today, and drops it. Months set by hand are left alone,
 * because those already said what they meant.
 */
function migrateBudgetDefaults(db: DB): DB {
  const legacy = (db as DB & { budgetDefaults?: Record<string, { amount: number; from: string }> }).budgetDefaults;
  if (!legacy || !Object.keys(legacy).length) return db;

  const budgets: DB["budgets"] = { ...db.budgets };
  const last = addMonths(thisMonth(), FUTURE_MONTHS);

  for (const [categoryId, standing] of Object.entries(legacy)) {
    if (!standing || typeof standing.amount !== "number" || !standing.from) continue;
    let m = standing.from;
    // Bounded, so a `from` far enough back to be nonsense cannot spin here.
    for (let n = 0; m <= last && n < 600; n++, m = addMonths(m, 1)) {
      if (budgets[m]?.[categoryId] !== undefined) continue;
      if (standing.amount === 0) continue;
      budgets[m] = { ...(budgets[m] ?? {}), [categoryId]: standing.amount };
    }
  }

  const { budgetDefaults: _gone, ...rest } = db as DB & { budgetDefaults?: unknown };
  return { ...(rest as DB), budgets };
}

export { buildDemoDB, emptyDB };

export function exportJSON(db: DB): string {
  return JSON.stringify({ ...db, exportedAt: new Date().toISOString() }, null, 2);
}

export function importJSON(text: string): DB {
  const parsed = JSON.parse(text) as DB;
  if (!Array.isArray(parsed.transactions) || !Array.isArray(parsed.accounts)) {
    throw new Error("That file doesn't look like a Sovereign backup.");
  }
  return migrate(parsed);
}

export function download(filename: string, contents: string, mime = "application/json"): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
