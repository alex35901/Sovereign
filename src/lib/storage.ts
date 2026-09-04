import type { DB } from "../types";
import { buildDemoDB, emptyDB } from "./seed";
import { migrateGoalAccounts } from "./goal-funding.js";
import { addMonths, thisMonth } from "./date.js";
import { FUTURE_MONTHS } from "./select.js";

const KEY = "sovereign.db.v1";

export function loadDB(): DB | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw) as DB);
  } catch {
    return null;
  }
}

let writeTimer: number | undefined;
/** Debounced — the reducer fires on every keystroke in an edit form. */
export function saveDB(db: DB): void {
  window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch (err) {
      console.error("Could not persist — storage is probably full.", err);
    }
  }, 250);
}

export function saveNow(db: DB): void {
  window.clearTimeout(writeTimer);
  localStorage.setItem(KEY, JSON.stringify(db));
}

export function clearDB(): void {
  localStorage.removeItem(KEY);
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
