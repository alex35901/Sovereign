import type { DB, Transaction } from "../types";
import { UNCATEGORIZED } from "./categories";
import { hash, uid } from "./id";
import { toISO } from "./date";

/** RFC-4180-ish parser: handles quoted fields, escaped quotes and CRLF. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type ColumnRole =
  | "date" | "merchant" | "statement" | "amount" | "debit" | "credit"
  | "category" | "tags" | "account" | "notes" | "ignore";

const HINTS: [ColumnRole, RegExp][] = [
  ["date", /^(date|transaction date|posted date|post date|trans date)$/i],
  ["merchant", /^(merchant|description|name|payee|original description|details)$/i],
  ["statement", /^(original statement|statement|raw description|bank description|original payee)$/i],
  ["amount", /^(amount|value)$/i],
  ["debit", /^(debit|withdrawal|outflow|charges?)$/i],
  ["credit", /^(credit|deposit|inflow|payments?)$/i],
  ["category", /^(category|categories)$/i],
  ["account", /^(account|account name|account_name)$/i],
  ["notes", /^(notes?|memo|comment)$/i],
  ["tags", /^(tags?|labels?)$/i],
];

/** Best-guess role for each header, covering Mint, Monarch and generic bank exports. */
export function guessColumns(header: string[]): ColumnRole[] {
  return header.map((h) => {
    const clean = h.trim();
    for (const [role, re] of HINTS) if (re.test(clean)) return role;
    if (/date/i.test(clean)) return "date";
    if (/amount/i.test(clean)) return "amount";
    if (/statement/i.test(clean)) return "statement";
    if (/^tags?$/i.test(clean)) return "tags";
    if (/desc|payee|merchant/i.test(clean)) return "merchant";
    return "ignore";
  });
}

/** Parses the many shapes of date a bank might hand you. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
  if (m) {
    const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${yr}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toISO(d);
}

export interface ImportRow {
  date: string;
  merchant: string;
  amount: number;
  /** The bank's own wording, kept beside the tidied merchant name. */
  statement?: string;
  categoryName?: string;
  /** Tag names as written in the file; resolved to ids when the rows land. */
  tagNames?: string[];
  notes?: string;
  accountName?: string;
}

/** "Business, Reimbursable" or "business;reimbursable" or "a|b". */
export const splitTags = (raw: string | undefined): string[] =>
  (raw ?? "").split(/[,;|]/).map((t) => t.trim()).filter(Boolean);

export interface ImportPlan {
  rows: ImportRow[];
  skipped: number;
  duplicates: number;
}

const cents = (s: string): number => {
  const clean = s.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  const n = Number.parseFloat(clean);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export const importKeyFor = (accountId: string, date: string, amount: number, merchant: string): string =>
  hash(`${accountId}|${date}|${amount}|${merchant.toLowerCase().trim()}`);

export function buildPlan(
  rows: string[][], roles: ColumnRole[], opts: { flipSign: boolean; accountId: string; existing: Transaction[] },
): ImportPlan {
  const col = (role: ColumnRole) => roles.indexOf(role);

  /**
   * How many of each key are already held, counted rather than merely seen.
   *
   * A set was wrong twice over. Two rent payments of the same amount on the
   * same day from two tenants share an account, a date, an amount and a
   * merchant — they are one key and two real transactions — and a set threw
   * the second away every time, in the file and against the database both.
   * Counting means a file holding two of something imports the second when
   * only one is already stored, and skips it when two are.
   */
  const held = new Map<string, number>();
  for (const t of opts.existing) {
    const k = t.importKey ?? importKeyFor(t.accountId, t.date, t.amount, t.merchant);
    held.set(k, (held.get(k) ?? 0) + 1);
  }
  const out: ImportRow[] = [];
  let skipped = 0;
  let duplicates = 0;

  for (const r of rows) {
    const date = parseDate(r[col("date")] ?? "");
    if (!date) { skipped++; continue; }
    const merchant = (r[col("merchant")] ?? "").trim() || "Unknown";
    let amount = 0;
    if (col("amount") >= 0) amount = cents(r[col("amount")] ?? "");
    else {
      const debit = col("debit") >= 0 ? cents(r[col("debit")] ?? "") : 0;
      const credit = col("credit") >= 0 ? cents(r[col("credit")] ?? "") : 0;
      amount = credit - Math.abs(debit);
    }
    if (opts.flipSign) amount = -amount;
    if (amount === 0) { skipped++; continue; }
    const key = importKeyFor(opts.accountId, date, amount, merchant);
    const already = held.get(key) ?? 0;
    if (already > 0) { held.set(key, already - 1); duplicates++; continue; }
    out.push({
      date, merchant, amount,
      statement: col("statement") >= 0 ? r[col("statement")]?.trim() || undefined : undefined,
      categoryName: col("category") >= 0 ? r[col("category")]?.trim() : undefined,
      tagNames: col("tags") >= 0 ? splitTags(r[col("tags")]) : undefined,
      notes: col("notes") >= 0 ? r[col("notes")]?.trim() : undefined,
      accountName: col("account") >= 0 ? r[col("account")]?.trim() : undefined,
    });
  }
  return { rows: out, skipped, duplicates };
}

/** Matches an imported category name to an existing category, case-insensitively. */
export function resolveCategory(db: DB, name: string | undefined, amount: number): string {
  if (name) {
    const hit = db.categories.find((c) => c.name.toLowerCase() === name.toLowerCase().trim());
    if (hit) return hit.id;
  }
  return amount > 0 ? "c_other_income" : UNCATEGORIZED;
}

/** Every tag named by a plan that this budget does not have yet. */
export function newTagNames(plan: ImportPlan, existing: { name: string }[]): string[] {
  const have = new Set(existing.map((t) => t.name.toLowerCase()));
  const out = new Map<string, string>();
  for (const r of plan.rows) {
    for (const name of r.tagNames ?? []) {
      if (!have.has(name.toLowerCase())) out.set(name.toLowerCase(), name);
    }
  }
  return [...out.values()];
}

export interface RowsToTxOpts {
  /** Lowercased tag name to id, covering both existing and just-created tags. */
  tagIds?: Map<string, string>;
  /** Imported rows are things you have already seen on a statement. */
  reviewed?: boolean;
}

export function rowsToTransactions(
  db: DB, plan: ImportPlan, accountId: string, opts: RowsToTxOpts = {},
): Transaction[] {
  return plan.rows.map((r) => ({
    id: uid("t"),
    accountId,
    date: r.date,
    merchant: r.merchant,
    // The file's own raw column when it has one; otherwise the merchant, which
    // is all there was to go on before this could be mapped.
    statement: r.statement || r.merchant,
    amount: r.amount,
    categoryId: resolveCategory(db, r.categoryName, r.amount),
    notes: r.notes || undefined,
    tags: (r.tagNames ?? [])
      .map((t) => opts.tagIds?.get(t.toLowerCase()))
      .filter((id): id is string => !!id),
    pending: false,
    reviewed: opts.reviewed ?? false,
    hideFromReports: false,
    importKey: importKeyFor(accountId, r.date, r.amount, r.merchant),
    createdAt: new Date().toISOString(),
  }));
}

/**
 * An account's balance history as CSV.
 *
 * Columns are named so the file reads straight back into Import history —
 * downloading, editing in a spreadsheet and re-importing is the point of it.
 */
export function balanceHistoryToCSV(account: { name: string; history: { date: string; balance: number }[] }): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ["Date", "Account", "Balance"];
  const body = account.history.map((h) =>
    [h.date, account.name, (h.balance / 100).toFixed(2)].map((v) => esc(String(v))).join(","),
  );
  return [head.join(","), ...body].join("\n");
}

export function toCSV(db: DB, txns: Transaction[]): string {
  const acc = new Map(db.accounts.map((a) => [a.id, a.name]));
  const cat = new Map(db.categories.map((c) => [c.id, c.name]));
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ["Date", "Merchant", "Category", "Account", "Original Statement", "Notes", "Amount", "Tags"];
  const body = txns.map((t) =>
    [
      t.date, t.merchant, cat.get(t.categoryId) ?? "", acc.get(t.accountId) ?? "",
      t.statement ?? "", t.notes ?? "", (t.amount / 100).toFixed(2),
      t.tags.map((id) => db.tags.find((g) => g.id === id)?.name ?? "").filter(Boolean).join("|"),
    ].map((v) => esc(String(v))).join(","),
  );
  return [head.join(","), ...body].join("\n");
}
