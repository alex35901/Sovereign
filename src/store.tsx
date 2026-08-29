import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Account, Category, DB, Goal, Holding, ID, MonthKey, Recurring, Rule, Tag, Transaction } from "./types";
import { buildDemoDB, emptyDB, loadDB, saveDB, saveNow } from "./lib/storage";
import { plannedFromHistory } from "./lib/seed";
import { addMonths, today } from "./lib/date";
import { uid } from "./lib/id";
import { applyRules } from "./lib/rules";
import { mergeHistory } from "./lib/balance-csv";
import { refreshVehicleValues } from "./lib/vehicle";

type Mutator = (db: DB) => DB;

interface Store {
  db: DB;
  /** Every write goes through here; `label` powers the undo toast. */
  apply: (fn: Mutator, label?: string) => void;
  undo: () => void;
  undoLabel: string | null;
  toast: string | null;
  notify: (msg: string) => void;
  actions: Actions;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}
export const useDB = (): DB => useStore().db;
export const useActions = (): Actions => useStore().actions;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<DB>(() => loadDB() ?? buildDemoDB());
  const [toast, setToast] = useState<string | null>(null);
  const undoStack = useRef<{ db: DB; label: string }[]>([]);
  const [undoLabel, setUndoLabel] = useState<string | null>(null);

  useEffect(() => { saveDB(db); }, [db]);
  // vehicles depreciate whether or not anyone opens their page
  const refreshed = useRef(false);
  useEffect(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    setDb((prev) => refreshVehicleValues(prev));
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = db.settings.theme;
  }, [db.settings.theme]);
  useEffect(() => {
    const flush = () => saveNow(db);
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [db]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3200);
  }, []);

  const apply = useCallback((fn: Mutator, label?: string) => {
    setDb((prev) => {
      if (label) {
        undoStack.current = [{ db: prev, label }, ...undoStack.current].slice(0, 12);
        setUndoLabel(label);
        window.setTimeout(() => setUndoLabel((l) => (l === label ? null : l)), 6000);
      }
      return fn(prev);
    });
  }, []);

  const undo = useCallback(() => {
    const top = undoStack.current[0];
    if (!top) return;
    undoStack.current = undoStack.current.slice(1);
    setDb(top.db);
    setUndoLabel(null);
    notify(`Undid: ${top.label}`);
  }, [notify]);

  const actions = useMemo(() => makeActions(apply, notify), [apply, notify]);

  const value: Store = { db, apply, undo, undoLabel, toast, notify, actions };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/* ── action creators ──────────────────────────────────────────────────── */

const replace = <T extends { id: ID }>(xs: T[], id: ID, patch: Partial<T>): T[] =>
  xs.map((x) => (x.id === id ? { ...x, ...patch } : x));

export interface Actions {
  resetDemo: () => void;
  resetEmpty: () => void;
  loadDB: (db: DB) => void;
  patchSettings: (patch: Partial<DB["settings"]>) => void;
  toggleTheme: () => void;

  addAccount: (a: Omit<Account, "id" | "order" | "history">) => void;
  updateAccount: (id: ID, patch: Partial<Account>) => void;
  setAccountBalance: (id: ID, balance: number) => void;
  importBalanceHistory: (id: ID, points: { date: string; balance: number }[], mode: "merge" | "replace") => void;
  setBalanceAt: (id: ID, date: string, balance: number) => void;
  deleteBalancePoint: (id: ID, date: string) => void;
  deleteAccount: (id: ID) => void;

  addTransaction: (t: Omit<Transaction, "id" | "createdAt" | "tags"> & { tags?: ID[] }) => void;
  addTransactions: (ts: Transaction[]) => void;
  updateTransaction: (id: ID, patch: Partial<Transaction>) => void;
  updateMany: (ids: ID[], patch: Partial<Transaction>, label: string) => void;
  addTagToMany: (ids: ID[], tagId: ID) => void;
  deleteTransactions: (ids: ID[]) => void;
  splitTransaction: (id: ID, splits: { categoryId: ID; amount: number; notes?: string }[]) => void;

  addCategory: (c: Omit<Category, "id" | "order">) => void;
  updateCategory: (id: ID, patch: Partial<Category>) => void;
  deleteCategory: (id: ID, reassignTo: ID) => void;
  addGroup: (name: string, kind: "income" | "expense") => void;
  updateGroup: (id: ID, patch: Partial<DB["groups"][number]>) => void;

  addTag: (name: string, color: string) => void;
  deleteTag: (id: ID) => void;

  setPlanned: (month: MonthKey, categoryId: ID, amount: number) => void;
  copyPreviousMonth: (month: MonthKey) => void;
  autofillBudget: (month: MonthKey) => void;
  clearBudget: (month: MonthKey) => void;

  addGoal: (g: Omit<Goal, "id" | "priority" | "archived">) => void;
  updateGoal: (id: ID, patch: Partial<Goal>) => void;
  deleteGoal: (id: ID) => void;

  upsertRecurring: (r: Recurring) => void;
  dismissRecurring: (r: Recurring) => void;

  addRule: (r: Omit<Rule, "id" | "order">) => void;
  updateRule: (id: ID, patch: Partial<Rule>) => void;
  deleteRule: (id: ID) => void;
  applyRuleToExisting: (id: ID) => void;

  addHolding: (h: Omit<Holding, "id">) => void;
  updateHolding: (id: ID, patch: Partial<Holding>) => void;
  deleteHolding: (id: ID) => void;
}

function makeActions(apply: (fn: Mutator, label?: string) => void, notify: (m: string) => void): Actions {
  return {
    resetDemo: () => apply(() => buildDemoDB(), "reset to demo data"),
    resetEmpty: () => apply(() => emptyDB(), "clear all data"),
    loadDB: (next) => apply(() => next, "restore backup"),
    patchSettings: (patch) => apply((db) => ({ ...db, settings: { ...db.settings, ...patch } })),
    toggleTheme: () =>
      apply((db) => ({ ...db, settings: { ...db.settings, theme: db.settings.theme === "dark" ? "light" : "dark" } })),

    addAccount: (a) =>
      apply((db) => ({
        ...db,
        accounts: [...db.accounts, {
          ...a, id: uid("a"), order: db.accounts.length,
          history: [{ date: today(), balance: a.balance }],
        }],
      })),
    updateAccount: (id, patch) => apply((db) => ({ ...db, accounts: replace(db.accounts, id, patch) })),
    setAccountBalance: (id, balance) =>
      apply((db) => ({
        ...db,
        accounts: db.accounts.map((a) => {
          if (a.id !== id) return a;
          const history = a.history.filter((h) => h.date !== today());
          history.push({ date: today(), balance });
          history.sort((x, y) => (x.date < y.date ? -1 : 1));
          return { ...a, balance, history };
        }),
      })),
    importBalanceHistory: (id, points, mode) =>
      apply((db) => ({
        ...db,
        accounts: db.accounts.map((a) => {
          if (a.id !== id) return a;
          const history = mergeHistory(a.history, points, mode);
          const newest = history[history.length - 1];
          return { ...a, history, balance: newest ? newest.balance : a.balance };
        }),
      }), `import ${points.length} balance point${points.length === 1 ? "" : "s"}`),
    setBalanceAt: (id, date, balance) =>
      apply((db) => ({
        ...db,
        accounts: db.accounts.map((a) => {
          if (a.id !== id) return a;
          const history = mergeHistory(a.history, [{ date, balance }], "merge");
          return { ...a, history, balance: history[history.length - 1].balance };
        }),
      })),
    deleteBalancePoint: (id, date) =>
      apply((db) => ({
        ...db,
        accounts: db.accounts.map((a) => {
          if (a.id !== id) return a;
          const history = a.history.filter((h) => h.date !== date);
          return { ...a, history, balance: history.length ? history[history.length - 1].balance : a.balance };
        }),
      }), "delete balance point"),
    deleteAccount: (id) =>
      apply((db) => ({
        ...db,
        accounts: db.accounts.filter((a) => a.id !== id),
        transactions: db.transactions.filter((t) => t.accountId !== id),
        holdings: db.holdings.filter((h) => h.accountId !== id),
      }), "delete account"),

    addTransaction: (t) =>
      apply((db) => ({
        ...db,
        transactions: [
          applyRules(db.rules, { ...t, tags: t.tags ?? [], id: uid("t"), createdAt: new Date().toISOString() }),
          ...db.transactions,
        ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
      })),
    addTransactions: (ts) =>
      apply((db) => ({
        ...db,
        transactions: [...ts, ...db.transactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
      }), `import ${ts.length} transactions`),
    updateTransaction: (id, patch) =>
      apply((db) => ({ ...db, transactions: replace(db.transactions, id, patch) })),
    updateMany: (ids, patch, label) =>
      apply((db) => {
        const set = new Set(ids);
        return { ...db, transactions: db.transactions.map((t) => (set.has(t.id) ? { ...t, ...patch } : t)) };
      }, label),
    addTagToMany: (ids, tagId) =>
      apply((db) => {
        const set = new Set(ids);
        return {
          ...db,
          transactions: db.transactions.map((t) =>
            set.has(t.id) && !t.tags.includes(tagId) ? { ...t, tags: [...t.tags, tagId] } : t),
        };
      }, `tag ${ids.length} transaction${ids.length === 1 ? "" : "s"}`),
    deleteTransactions: (ids) =>
      apply((db) => {
        const set = new Set(ids);
        return { ...db, transactions: db.transactions.filter((t) => !set.has(t.id)) };
      }, `delete ${ids.length} transaction${ids.length === 1 ? "" : "s"}`),
    splitTransaction: (id, splits) =>
      apply((db) => ({
        ...db,
        transactions: db.transactions.map((t) =>
          t.id === id
            ? { ...t, splits: splits.length ? splits.map((s) => ({ ...s, id: uid("s") })) : undefined }
            : t),
      }), "split transaction"),

    addCategory: (c) =>
      apply((db) => ({
        ...db,
        categories: [...db.categories, { ...c, id: uid("c"), order: db.categories.filter((x) => x.groupId === c.groupId).length }],
      })),
    updateCategory: (id, patch) => apply((db) => ({ ...db, categories: replace(db.categories, id, patch) })),
    deleteCategory: (id, reassignTo) =>
      apply((db) => ({
        ...db,
        categories: db.categories.filter((c) => c.id !== id),
        transactions: db.transactions.map((t) => (t.categoryId === id ? { ...t, categoryId: reassignTo } : t)),
      }), "delete category"),
    addGroup: (name, kind) =>
      apply((db) => ({ ...db, groups: [...db.groups, { id: uid("g"), name, kind, order: db.groups.length }] })),
    updateGroup: (id, patch) => apply((db) => ({ ...db, groups: replace(db.groups, id, patch) })),

    addTag: (name, color) => apply((db) => ({ ...db, tags: [...db.tags, { id: uid("tg"), name, color } as Tag] })),
    deleteTag: (id) =>
      apply((db) => ({
        ...db,
        tags: db.tags.filter((t) => t.id !== id),
        transactions: db.transactions.map((t) => ({ ...t, tags: t.tags.filter((x) => x !== id) })),
      })),

    setPlanned: (month, categoryId, amount) =>
      apply((db) => {
        const m = { ...(db.budgets[month] ?? {}) };
        if (amount <= 0) delete m[categoryId];
        else m[categoryId] = amount;
        return { ...db, budgets: { ...db.budgets, [month]: m } };
      }),
    copyPreviousMonth: (month) =>
      apply((db) => ({ ...db, budgets: { ...db.budgets, [month]: { ...(db.budgets[addMonths(month, -1)] ?? {}) } } }), "copy last month's budget"),
    autofillBudget: (month) =>
      apply((db) => ({ ...db, budgets: { ...db.budgets, [month]: plannedFromHistory(db, month) } }), "auto-fill budget"),
    clearBudget: (month) =>
      apply((db) => ({ ...db, budgets: { ...db.budgets, [month]: {} } }), "clear budget"),

    addGoal: (g) =>
      apply((db) => ({ ...db, goals: [...db.goals, { ...g, id: uid("gl"), priority: db.goals.length, archived: false }] })),
    updateGoal: (id, patch) => apply((db) => ({ ...db, goals: replace(db.goals, id, patch) })),
    deleteGoal: (id) => apply((db) => ({ ...db, goals: db.goals.filter((g) => g.id !== id) }), "delete goal"),

    upsertRecurring: (r) =>
      apply((db) => ({
        ...db,
        recurring: db.recurring.some((x) => x.id === r.id)
          ? db.recurring.map((x) => (x.id === r.id ? r : x))
          : [...db.recurring, r],
      })),
    dismissRecurring: (r) =>
      apply((db) => ({
        ...db,
        recurring: db.recurring.some((x) => x.id === r.id)
          ? db.recurring.map((x) => (x.id === r.id ? { ...x, dismissed: true } : x))
          : [...db.recurring, { ...r, dismissed: true }],
      }), "dismiss recurring item"),

    addRule: (r) => apply((db) => ({ ...db, rules: [...db.rules, { ...r, id: uid("r"), order: db.rules.length }] })),
    updateRule: (id, patch) => apply((db) => ({ ...db, rules: replace(db.rules, id, patch) })),
    deleteRule: (id) => apply((db) => ({ ...db, rules: db.rules.filter((r) => r.id !== id) }), "delete rule"),
    applyRuleToExisting: (id) =>
      apply((db) => {
        const rule = db.rules.find((r) => r.id === id);
        if (!rule) return db;
        let touched = 0;
        const transactions = db.transactions.map((t) => {
          const next = applyRules([rule], t);
          if (next !== t) touched++;
          return next;
        });
        notify(`Rule applied to ${touched} transaction${touched === 1 ? "" : "s"}.`);
        return { ...db, transactions };
      }, "apply rule to existing transactions"),

    addHolding: (h) => apply((db) => ({ ...db, holdings: [...db.holdings, { ...h, id: uid("h") }] })),
    updateHolding: (id, patch) => apply((db) => ({ ...db, holdings: replace(db.holdings, id, patch) })),
    deleteHolding: (id) => apply((db) => ({ ...db, holdings: db.holdings.filter((h) => h.id !== id) })),
  };
}
