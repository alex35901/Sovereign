import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Account, Category, DB, Goal, Holding, ID, MonthKey, Recurring, Rule, Tag, Transaction } from "./types";
import { buildDemoDB, emptyDB, loadDB, migrate, saveDB, saveNow } from "./lib/storage";
import { plannedFromHistory } from "./lib/seed";
import { addMonths, today } from "./lib/date";
import { uid } from "./lib/id";
import { applyRules } from "./lib/rules";
import { toRules } from "./lib/rules-import";
import type { ParsedRule } from "./lib/rules-import";
import { mergeHistory } from "./lib/balance-csv";
import { refreshVehicleValues } from "./lib/vehicle";
import { applyForward } from "./lib/select";
import { moveBudget } from "./lib/budget-move";
import { withGroupColors } from "./lib/category-colors";
import { allocate } from "./lib/goal-funding";

/** Tag colours for tags created by an import, spread across the palette. */
const TAG_TONES = ["--c5", "--c3", "--c1", "--c7", "--c9", "--c11", "--c2", "--c4", "--c6", "--c8"];
import { accountKeys } from "./lib/sync/merge";
import { added, record } from "./lib/activity";

type Mutator = (db: DB) => DB;

interface Store {
  db: DB;
  /** Every write goes through here; `label` powers the undo toast. */
  apply: (fn: Mutator, label?: string) => void;
  undo: () => void;
  undoLabel: string | null;
  toast: string | null;
  notify: (msg: string) => void;
  /** The offer to turn a just-made categorisation into a standing rule. */
  rulePrompt: RulePrompt | null;
  suggestRule: (p: Omit<RulePrompt, "key">) => void;
  dismissRulePrompt: () => void;
  /**
   * Adopts a document that came from the server. Deliberately not `apply`:
   * this is not an edit, so it must not land on the undo stack, where one
   * ctrl-Z would silently put a stale copy back and push it to every device.
   */
  /** Installs an outside document, migrated, and hands back what it installed. */
  replaceFromCloud: (next: DB) => DB;
  actions: Actions;
}

/** What a "create a rule for this?" offer needs to know. */
export interface RulePrompt {
  /** The merchant as it arrived, which is what a rule has to match on. */
  merchant: string;
  categoryId?: ID;
  /** The name it was changed to, when the edit was a rename. */
  renameTo?: string;
  /** Changes on every offer, so the countdown restarts rather than carrying on. */
  key: number;
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
  // Migrated on the way in whichever branch it came from. loadDB does its own,
  // but the demo did not, so a first run got whatever shape the seed happened
  // to be written in — and a goal that named an account showed nothing saved
  // until the page was next reloaded. Free when there is nothing to do.
  const [db, setDb] = useState<DB>(() => withGroupColors(migrate(loadDB() ?? buildDemoDB())));
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
    // The phone paints its status bar this colour when the app is running from a
    // home screen. index.html can only name one, and the theme is a stored
    // setting rather than a system preference, so the answer is only known here
    // — otherwise light mode gets a black bar sitting above a white page.
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", db.settings.theme === "light" ? "#f4f6f9" : "#0e1116");
  }, [db.settings.theme]);
  useEffect(() => {
    const flush = () => saveNow(db);
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [db]);

  const [rulePrompt, setRulePrompt] = useState<RulePrompt | null>(null);
  const dismissRulePrompt = useCallback(() => setRulePrompt(null), []);
  const suggestRule = useCallback((p: Omit<RulePrompt, "key">) => {
    // Nothing to match on without a merchant, and nothing worth automating
    // unless the edit actually set something.
    if (!p.merchant.trim() || (!p.categoryId && !p.renameTo?.trim())) return;
    setRulePrompt({ ...p, key: Date.now() });
  }, []);

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
      return withGroupColors(fn(prev));
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

  /**
   * Take a document from outside and make it this browser's.
   *
   * Migrated here rather than at each call site because this is the one door
   * an outside document comes through — the sync loop, the Settings card's
   * Load button, and the unlock screen all arrive at it — and one of them
   * skipping the migration is exactly the bug this prevents.
   *
   * Returns what it installed. A caller that needs to know whether the
   * document it handed over is still what the server holds can compare the two
   * by identity: an unchanged document comes back as the very same object.
   */
  const replaceFromCloud = useCallback((next: DB): DB => {
    const normalized = withGroupColors(migrate(next));
    undoStack.current = [];
    setUndoLabel(null);
    setDb(normalized);
    return normalized;
  }, []);

  const actions = useMemo(() => makeActions(apply, notify), [apply, notify]);

  const value: Store = {
    db, apply, undo, undoLabel, toast, notify, replaceFromCloud, actions,
    rulePrompt, suggestRule, dismissRulePrompt,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/* ── action creators ──────────────────────────────────────────────────── */

const replace = <T extends { id: ID }>(xs: T[], id: ID, patch: Partial<T>): T[] =>
  xs.map((x) => (x.id === id ? { ...x, ...patch } : x));

/**
 * Applies a change to the named transactions and logs whatever it moved.
 *
 * Every path that edits a transaction goes through here, so nothing can change
 * without leaving a line in its history.
 */
const editTransactions = (db: DB, ids: Set<ID> | null, edit: (t: Transaction) => Transaction): Transaction[] => {
  const at = new Date().toISOString();
  return db.transactions.map((t) => {
    if (ids && !ids.has(t.id)) return t;
    const next = edit(t);
    return next === t ? t : record(db, t, next, at);
  });
};

/** Every transaction with one rule's actions applied. */
const runRule = (db: DB, rule: Rule): Transaction[] =>
  editTransactions(db, null, (t) => applyRules([rule], t));

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
  closeAccount: (id: ID) => void;
  reopenAccount: (id: ID) => void;
  forgetDeletedAccounts: () => void;

  addTransaction: (t: Omit<Transaction, "id" | "createdAt" | "tags"> & { tags?: ID[] }) => void;
  addTransactions: (ts: Transaction[]) => void;
  /**
   * A CSV import, with any tags the file named created in the same write.
   *
   * `build` is handed the resolved tag ids, because the rows cannot be built
   * until the tags exist and the tags must not exist unless the rows land —
   * doing it in two steps would leave stray tags behind on a failure, and two
   * entries on the undo stack.
   */
  importTransactions: (
    tagNames: string[],
    build: (tagIds: Map<string, string>) => Transaction[],
  ) => void;
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
  deleteGroup: (id: ID) => void;

  addTag: (name: string, color: string) => void;
  deleteTag: (id: ID) => void;

  setPlanned: (month: MonthKey, categoryId: ID, amount: number) => void;
  applyPlannedForward: (month: MonthKey, categoryId: ID, amount: number) => void;
  moveBudget: (month: MonthKey, fromId: ID, toId: ID, amount: number) => void;
  clearPlannedForward: (categoryId: ID) => void;
  copyPreviousMonth: (month: MonthKey) => void;
  autofillBudget: (month: MonthKey) => void;
  clearBudget: (month: MonthKey) => void;

  addGoal: (g: Omit<Goal, "id" | "priority" | "archived">) => void;
  /** Whether an account's balance is money set aside for goals. */
  setGoalAccount: (accountId: ID, on: boolean) => void;
  /** Send an account's leftovers to one goal, or stop. */
  setAutoGoal: (accountId: ID, goalId: ID | null) => void;
  /** Give a goal `amount` of one account, clamped to what is unassigned. */
  allocateToGoal: (goalId: ID, accountId: ID, amount: number) => void;
  updateGoal: (id: ID, patch: Partial<Goal>) => void;
  deleteGoal: (id: ID) => void;

  upsertRecurring: (r: Recurring) => void;
  dismissRecurring: (r: Recurring) => void;

  /** `applyToExisting` runs the saved rule over the transactions already held. */
  addRule: (r: Omit<Rule, "id" | "order">, applyToExisting?: boolean) => void;
  /**
   * Brings in a parsed Monarch export as one step. An import of a hundred rules
   * added one at a time would be a hundred entries on the undo stack, and
   * undoing it would mean pressing undo a hundred times.
   *
   * Tags an imported rule refers to are created here if they do not exist, in
   * the same write, so a rule can never end up pointing at a tag id that isn't
   * there. Returns how many rules were made.
   */
  importRules: (parsed: ParsedRule[], applyToExisting?: boolean) => void;
  updateRule: (id: ID, patch: Partial<Rule>, applyToExisting?: boolean) => void;
  deleteRule: (id: ID) => void;
  applyRuleToExisting: (id: ID) => void;
  /**
   * Runs every enabled rule over every transaction, in order.
   *
   * One pass rather than one per rule: applyRules already walks them in order
   * for each transaction, so a later rule wins over an earlier one exactly as
   * it does when a transaction arrives — and a transaction two rules touch
   * gets one entry in its history rather than two.
   */
  applyAllRules: () => void;
  /** Recolours a whole group; every category in it follows. */
  setGroupColor: (id: ID, color: string) => void;

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
      apply((db) => {
        const gone = db.accounts.find((a) => a.id === id);
        // Remembered, or the next pull hands the same account straight back and
        // the delete looks like it silently failed.
        const keys = gone ? accountKeys(gone) : [];
        return {
          ...db,
          accounts: db.accounts.filter((a) => a.id !== id),
          transactions: db.transactions.filter((t) => t.accountId !== id),
          holdings: db.holdings.filter((h) => h.accountId !== id),
          settings: {
            ...db.settings,
            deletedAccountKeys: [...new Set([...(db.settings.deletedAccountKeys ?? []), ...keys])],
          },
        };
      }, "delete account"),

    closeAccount: (id) =>
      apply((db) => ({
        ...db,
        accounts: db.accounts.map((a) => {
          if (a.id !== id) return a;
          const on = today();
          return {
            ...a,
            balance: 0,
            closedAt: on,
            // A final zero point, so the chart shows it settling rather than
            // ending on whatever it happened to hold.
            history: [...a.history.filter((h) => h.date !== on), { date: on, balance: 0 }]
              .sort((x, y) => (x.date < y.date ? -1 : 1)),
          };
        }),
      }), "close account"),

    reopenAccount: (id) =>
      apply((db) => ({
        ...db,
        accounts: db.accounts.map((a) => (a.id === id ? { ...a, closedAt: undefined } : a)),
      }), "reopen account"),

    forgetDeletedAccounts: () =>
      apply((db) => ({
        ...db,
        settings: { ...db.settings, deletedAccountKeys: [] },
      }), "forget deleted accounts"),

    addTransaction: (t) =>
      apply((db) => {
        const at = new Date().toISOString();
        const fresh = { ...t, tags: t.tags ?? [], id: uid("t"), createdAt: at, activity: [added("manual", at)] };
        // Rules run at the door, and what they change is logged like any edit.
        const ruled = record(db, fresh, applyRules(db.rules, fresh), at);
        return {
          ...db,
          transactions: [ruled, ...db.transactions]
            .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
        };
      }),
    importTransactions: (tagNames, build) =>
      apply((db) => {
        const tagIds = new Map(db.tags.map((t) => [t.name.toLowerCase(), t.id]));
        const made: Tag[] = [];
        for (const name of tagNames) {
          if (tagIds.has(name.toLowerCase())) continue;
          const tag: Tag = { id: uid("tg"), name, color: TAG_TONES[made.length % TAG_TONES.length]! };
          made.push(tag);
          tagIds.set(name.toLowerCase(), tag.id);
        }
        const ts = build(tagIds);
        const at = new Date().toISOString();
        const logged = ts.map((t) => (t.activity?.length ? t : { ...t, activity: [added("csv", t.createdAt || at)] }));
        return {
          ...db,
          tags: [...db.tags, ...made],
          transactions: [...logged, ...db.transactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
        };
      }, `import ${tagNames.length ? "transactions and tags" : "transactions"}`),

    addTransactions: (ts) =>
      apply((db) => {
        const at = new Date().toISOString();
        const logged = ts.map((t) => (t.activity?.length ? t : { ...t, activity: [added("csv", t.createdAt || at)] }));
        return {
          ...db,
          transactions: [...logged, ...db.transactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
        };
      }, `import ${ts.length} transactions`),
    updateTransaction: (id, patch) =>
      apply((db) => ({
        ...db,
        transactions: editTransactions(db, new Set([id]), (t) => ({ ...t, ...patch })),
      })),
    updateMany: (ids, patch, label) =>
      apply((db) => ({
        ...db,
        transactions: editTransactions(db, new Set(ids), (t) => ({ ...t, ...patch })),
      }), label),
    addTagToMany: (ids, tagId) =>
      apply((db) => ({
        ...db,
        transactions: editTransactions(db, new Set(ids), (t) =>
          t.tags.includes(tagId) ? t : { ...t, tags: [...t.tags, tagId] }),
      }), `tag ${ids.length} transaction${ids.length === 1 ? "" : "s"}`),
    deleteTransactions: (ids) =>
      apply((db) => {
        const set = new Set(ids);
        return { ...db, transactions: db.transactions.filter((t) => !set.has(t.id)) };
      }, `delete ${ids.length} transaction${ids.length === 1 ? "" : "s"}`),
    splitTransaction: (id, splits) =>
      apply((db) => ({
        ...db,
        transactions: editTransactions(db, new Set([id]), (t) => ({
          ...t,
          splits: splits.length ? splits.map((s) => ({ ...s, id: uid("s") })) : undefined,
        })),
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
    deleteGroup: (id) =>
      apply((db) => {
        // a group holding categories can't go — the categories would be orphaned
        if (db.categories.some((c) => c.groupId === id)) return db;
        return { ...db, groups: db.groups.filter((g) => g.id !== id) };
      }, "delete group"),

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
        const standing = db.budgetDefaults?.[categoryId];
        const covered = Boolean(standing && month >= standing.from);
        // dropping the entry would hand the month back to a standing amount, so
        // an explicit zero has to stay explicit where one exists
        if (amount <= 0 && !covered) delete m[categoryId];
        else m[categoryId] = Math.max(0, amount);
        return { ...db, budgets: { ...db.budgets, [month]: m } };
      }),
    applyPlannedForward: (month, categoryId, amount) =>
      apply((db) => applyForward(db, month, categoryId, amount), "apply to all future months"),
    moveBudget: (month, fromId, toId, amount) =>
      apply((db) => moveBudget(db, month, fromId, toId, amount).db, "move money between categories"),
    clearPlannedForward: (categoryId) =>
      apply((db) => {
        const { [categoryId]: _removed, ...rest } = db.budgetDefaults ?? {};
        return { ...db, budgetDefaults: rest };
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

    setGoalAccount: (accountId, on) =>
      apply((db) => ({
        ...db,
        // Dropping an account releases what the goals held there. Leaving the
        // allocations behind would keep them in every total while the account
        // they refer to is no longer on the table.
        goals: on ? db.goals : db.goals.map((g) => {
          if (!g.allocations?.[accountId]) return g;
          const allocations = { ...g.allocations };
          delete allocations[accountId];
          return { ...g, allocations };
        }),
        accounts: db.accounts.map((a) => (a.id === accountId
          ? { ...a, goalAccount: on, autoGoalId: on ? a.autoGoalId : undefined }
          : a)),
      }), on ? "add goal account" : "remove goal account"),

    setAutoGoal: (accountId, goalId) =>
      apply((db) => ({
        ...db,
        accounts: db.accounts.map((a) => (a.id === accountId ? { ...a, autoGoalId: goalId ?? undefined } : a)),
      }), "auto-allocate"),

    allocateToGoal: (goalId, accountId, amount) =>
      apply((db) => allocate(db, goalId, accountId, amount), "allocate"),
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

    addRule: (r, applyToExisting) =>
      apply((db) => {
        const rule = { ...r, id: uid("r"), order: db.rules.length };
        const rules = [...db.rules, rule];
        // Saving and back-filling is one step, so one undo puts back both the
        // rule and every transaction it just rewrote.
        return { ...db, rules, transactions: applyToExisting ? runRule(db, rule) : db.transactions };
      }, "add rule"),

    importRules: (parsed, applyToExisting) =>
      apply((db) => {
        if (!parsed.length) return db;

        // Tags first, so every rule below resolves to an id that exists.
        const tagIds = new Map(db.tags.map((t) => [t.name.toLowerCase(), t.id]));
        const madeTags: Tag[] = [];
        for (const name of new Set(parsed.flatMap((p) => p.tags))) {
          if (tagIds.has(name.toLowerCase())) continue;
          const tag: Tag = { id: uid("tg"), name, color: TAG_TONES[madeTags.length % TAG_TONES.length]! };
          madeTags.push(tag);
          tagIds.set(name.toLowerCase(), tag.id);
        }

        const added = toRules(parsed, db.rules.length, () => uid("r"), tagIds);
        let out: DB = { ...db, tags: [...db.tags, ...madeTags], rules: [...db.rules, ...added] };
        if (applyToExisting) {
          // In the order they were added, which is the order they run in when a
          // transaction arrives, so a later rule wins the same way either time.
          for (const rule of added) out = { ...out, transactions: runRule(out, rule) };
        }
        return out;
      }, `import ${parsed.length} rule${parsed.length === 1 ? "" : "s"}`),

    updateRule: (id, patch, applyToExisting) =>
      apply((db) => {
        const rules = replace(db.rules, id, patch);
        const rule = rules.find((r) => r.id === id);
        return {
          ...db, rules,
          transactions: applyToExisting && rule ? runRule(db, rule) : db.transactions,
        };
      }, "update rule"),
    deleteRule: (id) => apply((db) => ({ ...db, rules: db.rules.filter((r) => r.id !== id) }), "delete rule"),
    applyRuleToExisting: (id) =>
      apply((db) => {
        const rule = db.rules.find((r) => r.id === id);
        if (!rule) return db;
        const transactions = runRule(db, rule);
        const touched = transactions.filter((t, i) => t !== db.transactions[i]).length;
        notify(`Rule applied to ${touched} transaction${touched === 1 ? "" : "s"}.`);
        return { ...db, transactions };
      }, "apply rule to existing transactions"),

    setGroupColor: (id, color) =>
      apply((db) => ({
        ...db,
        groups: db.groups.map((g) => (g.id === id ? { ...g, color } : g)),
      }), "recolour group"),

    applyAllRules: () =>
      apply((db) => {
        const enabled = db.rules.filter((r) => r.enabled);
        if (!enabled.length) {
          notify("No rules are switched on.");
          return db;
        }
        const transactions = editTransactions(db, null, (t) => applyRules(enabled, t));
        const touched = transactions.filter((t, i) => t !== db.transactions[i]).length;
        notify(touched
          ? `Ran ${enabled.length} rule${enabled.length === 1 ? "" : "s"} — ${touched} transaction${touched === 1 ? "" : "s"} changed.`
          : `Ran ${enabled.length} rule${enabled.length === 1 ? "" : "s"} — nothing needed changing.`);
        return { ...db, transactions };
      }, "run all rules"),

    addHolding: (h) => apply((db) => ({ ...db, holdings: [...db.holdings, { ...h, id: uid("h") }] })),
    updateHolding: (id, patch) => apply((db) => ({ ...db, holdings: replace(db.holdings, id, patch) })),
    deleteHolding: (id) => apply((db) => ({ ...db, holdings: db.holdings.filter((h) => h.id !== id) })),
  };
}
