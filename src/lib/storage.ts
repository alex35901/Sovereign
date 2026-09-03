import type { DB } from "../types";
import { buildDemoDB, emptyDB } from "./seed";
import { migrateGoalAccounts } from "./goal-funding.js";

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

/** Fill in fields added by later versions so old exports keep working. */
function migrate(db: DB): DB {
  const base = emptyDB();
  const merged: DB = { ...base, ...db, settings: { ...base.settings, ...db.settings } };
  merged.transactions = merged.transactions.map((t) => ({ ...t, tags: t.tags ?? [] }));
  merged.accounts = merged.accounts.map((a) => ({ ...a, history: a.history ?? [] }));
  // Goals used to name whole accounts; they hold amounts now. Runs once — it
  // leaves a document that already has allocations alone.
  return migrateGoalAccounts(merged);
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
