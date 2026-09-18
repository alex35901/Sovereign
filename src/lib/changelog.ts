import type { Budgets, DB, ID, Transaction } from "../types.js";
import { record } from "./activity.js";
import { uid } from "./id.js";

/**
 * A record of every change made in this browser, and how to take one back.
 *
 * The undo toast is a snapshot of the whole document: fast, exact, and useless
 * ten minutes later, because putting a whole document back throws away
 * everything done since. This keeps the other half of the story — for each
 * action, only the rows and fields it actually moved — so a mistake made an
 * hour ago can be put back without unpicking the hour.
 *
 * That means an undo here is a patch, not a rewind. A field that has been
 * changed again since is left exactly as it is and counted, because the later
 * edit is the more recent statement of what the reader wanted.
 *
 * Kept in this browser, not in the document: it is a list of edits made here,
 * it never leaves the device, and it is never worth pushing to another one.
 */

export const TABLES = [
  "accounts", "groups", "categories", "transactions", "tags", "goals", "recurring", "rules", "holdings",
] as const;
export type TableName = (typeof TABLES)[number];

/** Singular and plural, for counting rows out loud. */
const NOUN: Record<TableName, [string, string]> = {
  accounts: ["account", "accounts"],
  groups: ["category group", "category groups"],
  categories: ["category", "categories"],
  transactions: ["transaction", "transactions"],
  tags: ["tag", "tags"],
  goals: ["goal", "goals"],
  recurring: ["recurring item", "recurring items"],
  rules: ["rule", "rules"],
  holdings: ["holding", "holdings"],
};

export const plural = (n: number, [one, many]: [string, string]): string => `${n} ${n === 1 ? one : many}`;

/**
 * Fields the machine keeps about itself, rather than values somebody set.
 *
 * A transaction's activity and an account's balance history only ever grow, so
 * reverting either would delete the very lines describing the change being
 * undone, and every row would read as a conflict because something was
 * appended to all of them. The timestamps are the same kind of thing: marks
 * left by the last sync, not edits anybody would want back.
 *
 * Leaving them out keeps an entry small as well. An account's history is
 * hundreds of dated balances, and storing two copies of it on every hourly
 * pull would spend the whole storage budget on a log nobody would undo.
 */
const NOT_REVERTED = new Set(["activity", "history", "lastSyncedAt", "valuationTriedAt"]);

/** Field names as they are said on screen. */
export const FIELD: Record<string, string> = {
  accountId: "Account",
  amount: "Amount",
  bucket: "Books",
  categoryId: "Category",
  date: "Date",
  groupId: "Group",
  hideFromReports: "Hidden from reports",
  merchant: "Merchant",
  name: "Name",
  notes: "Notes",
  pending: "Pending",
  reviewed: "Reviewed",
  splits: "Split",
  tags: "Tags",
  taxLine: "Tax line",
};

export const fieldName = (key: string): string =>
  FIELD[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

type Row = { id: ID } & Record<string, unknown>;

/**
 * A field that was not there is stored as null, not left out.
 *
 * JSON.stringify drops keys whose value is undefined, so "this field did not
 * exist" would not survive being written to storage and the field could never
 * be taken back off again.
 */
const stored = (v: unknown): unknown => (v === undefined ? null : v);

const same = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(stored(a)) === JSON.stringify(stored(b));

export interface RowChange {
  id: ID;
  /** Only the fields that moved. null means the field was not there. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface TableDiff {
  table: TableName;
  /** Ids of rows this action created, which undoing takes away again. */
  added: ID[];
  /** Whole rows this action deleted, which undoing puts back. */
  removed: Row[];
  changed: RowChange[];
}

/** budgets[month][categoryId], one cell at a time. */
export interface BudgetChange {
  month: string;
  categoryId: ID;
  before: number | null;
  after: number | null;
}

export interface LoggedAction {
  id: string;
  label: string;
  at: string;
  /** The label was worked out from the change rather than given by the caller. */
  auto?: boolean;
  tables: TableDiff[];
  budgets: BudgetChange[];
  /** When this action was taken back, if it has been. */
  revertedAt?: string;
  /** Too much to keep: what it was is remembered, how to put it back is not. */
  tooBig?: boolean;
}

/** A table read as plain rows; every one of them is a record with an id. */
const rowsOf = (db: DB, table: TableName): Row[] => (db[table] ?? []) as unknown as Row[];

function diffTable(table: TableName, before: Row[], after: Row[]): TableDiff | null {
  if (before === after) return null;
  const was = new Map(before.map((r) => [r.id, r]));
  const added: ID[] = [];
  const changed: RowChange[] = [];
  const seen = new Set<ID>();
  for (const row of after) {
    seen.add(row.id);
    const old = was.get(row.id);
    if (!old) { added.push(row.id); continue; }
    if (old === row) continue;
    const b: Record<string, unknown> = {};
    const a: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(old), ...Object.keys(row)])) {
      if (NOT_REVERTED.has(key) || same(old[key], row[key])) continue;
      b[key] = stored(old[key]);
      a[key] = stored(row[key]);
    }
    if (Object.keys(a).length) changed.push({ id: row.id, before: b, after: a });
  }
  const removed = before.filter((r) => !seen.has(r.id));
  if (!added.length && !removed.length && !changed.length) return null;
  return { table, added, removed, changed };
}

function diffBudgets(before: Budgets, after: Budgets): BudgetChange[] {
  if (before === after) return [];
  const out: BudgetChange[] = [];
  for (const month of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const b = before?.[month] ?? {};
    const a = after?.[month] ?? {};
    if (b === a) continue;
    for (const categoryId of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (b[categoryId] === a[categoryId]) continue;
      out.push({ month, categoryId, before: b[categoryId] ?? null, after: a[categoryId] ?? null });
    }
  }
  return out;
}

/**
 * What changed between two documents, or null if nothing this can put back did.
 *
 * An unnamed action is named after what it did. Settings, the forecast and the
 * Hopper thread are not among the tables, so changing the theme or asking a
 * question is not an action at all and leaves no entry.
 */
export function diffAction(before: DB, after: DB, label: string | undefined, at: string): LoggedAction | null {
  const tables: TableDiff[] = [];
  for (const table of TABLES) {
    const d = diffTable(table, rowsOf(before, table), rowsOf(after, table));
    if (d) tables.push(d);
  }
  const budgets = diffBudgets(before.budgets, after.budgets);
  if (!tables.length && !budgets.length) return null;
  return label
    ? { id: uid("h"), label, at, tables, budgets }
    : { id: uid("h"), label: autoLabel(tables, budgets), at, auto: true, tables, budgets };
}

/** How many distinct fields one field name covers before it stops helping. */
const NAMED_FIELDS = 2;

/**
 * What to call an action that did not name itself.
 *
 * Most writes carry a label because the undo toast needs one, but the ones
 * that do not are some of the most ordinary edits in the app — changing one
 * transaction is the obvious case. A history that left those out would be a
 * history of the unusual, which is the opposite of useful, so the change
 * describes itself instead.
 */
export function autoLabel(tables: TableDiff[], budgets: BudgetChange[]): string {
  const parts: string[] = [];
  for (const t of tables) {
    if (t.added.length) parts.push(`${plural(t.added.length, NOUN[t.table])} added`);
    if (t.removed.length) parts.push(`${plural(t.removed.length, NOUN[t.table])} deleted`);
    if (!t.changed.length) continue;
    const fields = new Set(t.changed.flatMap((c) => Object.keys(c.after)));
    const named = [...fields].map(fieldName).sort().join(" and ");
    parts.push(fields.size <= NAMED_FIELDS
      ? `${named} changed on ${plural(t.changed.length, NOUN[t.table])}`
      : `${plural(t.changed.length, NOUN[t.table])} changed`);
  }
  if (budgets.length) parts.push(`${plural(budgets.length, ["budget amount", "budget amounts"])} changed`);
  return parts.length ? parts.join(", ") : "Something changed";
}

/** "412 transactions, 1 rule" — what an action touched, for the list. */
export function actionSummary(a: LoggedAction): string {
  const parts = a.tables.map((t) => plural(t.added.length + t.removed.length + t.changed.length, NOUN[t.table]));
  if (a.budgets.length) parts.push(`${a.budgets.length === 1 ? "1 budget" : `${a.budgets.length} budgets`}`);
  return parts.join(", ");
}

/** How many rows an undo would have to put back. */
export const actionSize = (a: LoggedAction): number =>
  a.budgets.length + a.tables.reduce((n, t) => n + t.added.length + t.removed.length + t.changed.length, 0);

export interface RevertResult {
  db: DB;
  /** Rows put back exactly as they were. */
  restored: number;
  /** Rows left alone, because they were changed again after this action. */
  skipped: number;
}

/** `row`, with `patch` applied; a null in the patch takes the field off. */
function patched(row: Row, patch: Record<string, unknown>): Row {
  const next: Row = { ...row };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * The document with one action taken back, and a count of what could not be.
 *
 * A row is only put back when every field this action moved still holds the
 * value this action left. Anything touched since is left as it stands — the
 * point of undoing one action out of order is that the others survive it.
 */
export function revert(db: DB, action: LoggedAction, at: string): RevertResult {
  let out = db;
  let restored = 0;
  let skipped = 0;

  for (const diff of action.tables) {
    const rows = rowsOf(out, diff.table);
    const dropped = new Set(diff.added);
    const byId = new Map(rows.map((r) => [r.id, r]));
    let next = rows;

    if (dropped.size) {
      const kept = rows.filter((r) => !dropped.has(r.id));
      restored += rows.length - kept.length;
      skipped += dropped.size - (rows.length - kept.length);
      next = kept;
    }

    if (diff.changed.length) {
      next = next.map((row) => {
        const change = diff.changed.find((c) => c.id === row.id);
        if (!change) return row;
        const stale = Object.keys(change.after).some((k) => !same(row[k], change.after[k]));
        if (stale) { skipped++; return row; }
        restored++;
        const back = patched(row, change.before);
        return diff.table === "transactions"
          ? (record(db, row as unknown as Transaction, back as unknown as Transaction, at) as unknown as Row)
          : back;
      });
      // A row this action changed and something else has since deleted cannot
      // be put back into the shape it had; say so rather than resurrecting it.
      skipped += diff.changed.filter((c) => !byId.has(c.id)).length;
    }

    const back = diff.removed.filter((r) => !byId.has(r.id));
    restored += back.length;
    skipped += diff.removed.length - back.length;
    if (back.length) next = [...next, ...back];

    if (next !== rows) out = { ...out, [diff.table]: next };
  }

  if (action.budgets.length) {
    const budgets: Budgets = { ...out.budgets };
    let touched = false;
    for (const cell of action.budgets) {
      const month = { ...(budgets[cell.month] ?? {}) };
      const now = month[cell.categoryId] ?? null;
      if (now !== cell.after) { skipped++; continue; }
      if (cell.before === null) delete month[cell.categoryId];
      else month[cell.categoryId] = cell.before;
      budgets[cell.month] = month;
      restored++;
      touched = true;
    }
    if (touched) out = { ...out, budgets };
  }

  return { db: out, restored, skipped };
}

/** What to say once an undo has run. */
export function revertMessage(a: LoggedAction, r: RevertResult): string {
  // Nothing restored at all is its own answer, not a put-back with a caveat.
  // It is what pressing this after the toast undo already took the same action
  // back looks like, and "put back, 12 left alone" would read as a failure.
  if (!r.restored) return `Nothing left to put back: ${a.label}`;
  const head = `Put back: ${a.label}`;
  if (!r.skipped) return head;
  return `${head} · ${r.skipped} left alone, changed again since`;
}

const KEY = "sovereign.changelog.v1";
/** Enough to cover a long session; trimmed oldest-first when it runs over. */
export const KEPT = 120;
/** Roughly a quarter of the smallest localStorage quota, shared with the document. */
export const MAX_BYTES = 1_000_000;

/**
 * Newest first, trimmed to what is worth keeping.
 *
 * One action can be bigger than the whole budget on its own: restoring a
 * backup or resetting to the demo replaces every row in the document, and
 * keeping the old ones would be a second copy of the document in a browser
 * that is already storing one. Those are remembered as having happened, with
 * nothing to put back — which is honest, and is a good deal better than the
 * alternative of them pushing every real edit out of the list.
 */
export function trim(log: LoggedAction[]): LoggedAction[] {
  const out = log
    .slice(0, KEPT)
    .map((a) => (JSON.stringify(a).length > MAX_BYTES
      ? { ...a, tables: [], budgets: [], tooBig: true }
      : a));
  while (out.length > 1 && JSON.stringify(out).length > MAX_BYTES) out.pop();
  return out;
}

export function loadLog(): LoggedAction[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as LoggedAction[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLog(log: LoggedAction[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(log));
  } catch {
    // Storage is full. The document itself matters more than its history, so
    // drop the older half and try once rather than letting the write throw.
    try { localStorage.setItem(KEY, JSON.stringify(log.slice(0, Math.floor(log.length / 2)))); } catch { /* give up */ }
  }
}

export function clearLog(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
