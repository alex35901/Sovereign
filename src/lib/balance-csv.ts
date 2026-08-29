import type { Account, ISODate } from "../types";
import { parseCSV, parseDate } from "./csv";

export interface BalancePoint { date: ISODate; balance: number }

export interface BalancePlan {
  /** Compressed points, ascending by date. */
  points: BalancePoint[];
  /** Rows read before compression. */
  rowsRead: number;
  skipped: number;
  /** Distinct labels found in the account column, if there was one. */
  accountLabels: string[];
  first?: BalancePoint;
  last?: BalancePoint;
}

export type BalanceRole = "date" | "balance" | "account" | "ignore";

const HINTS: [BalanceRole, RegExp][] = [
  ["date", /^(date|as of|as_of|month|day|period)$/i],
  ["balance", /^(balance|value|amount|total|equity|worth)$/i],
  ["account", /^(account|account name|property|name|address)$/i],
];

export function guessBalanceColumns(header: string[]): BalanceRole[] {
  return header.map((h) => {
    const clean = h.trim();
    for (const [role, re] of HINTS) if (re.test(clean)) return role;
    if (/date/i.test(clean)) return "date";
    if (/balance|value|amount/i.test(clean)) return "balance";
    if (/account|name/i.test(clean)) return "account";
    return "ignore";
  });
}

const cents = (raw: string): number | null => {
  const clean = raw.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!clean) return null;
  const n = Number.parseFloat(clean);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * Collapses a daily series to its change points.
 *
 * Exports like these repeat the same figure every day until it moves, and
 * balances are forward-filled when charting, so only the changes carry
 * information. The first and last points are always kept to pin the range.
 */
export function compress(points: BalancePoint[]): BalancePoint[] {
  if (points.length < 3) return points;
  const out: BalancePoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    if (points[i].balance !== out[out.length - 1].balance) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function buildBalancePlan(
  rows: string[][],
  roles: BalanceRole[],
  opts: { negate: boolean; accountLabel?: string },
): BalancePlan {
  const dateCol = roles.indexOf("date");
  const balanceCol = roles.indexOf("balance");
  const accountCol = roles.indexOf("account");

  const byDate = new Map<string, number>();
  const labels = new Set<string>();
  let skipped = 0;
  let rowsRead = 0;

  for (const row of rows) {
    const label = accountCol >= 0 ? (row[accountCol] ?? "").trim() : "";
    if (label) labels.add(label);
    if (opts.accountLabel && label && label !== opts.accountLabel) continue;

    const date = parseDate(row[dateCol] ?? "");
    const value = balanceCol >= 0 ? cents(row[balanceCol] ?? "") : null;
    if (!date || value === null) { skipped++; continue; }
    rowsRead++;
    // a later row for the same date wins
    byDate.set(date, opts.negate ? -Math.abs(value) : value);
  }

  const ordered = [...byDate.entries()]
    .map(([date, balance]) => ({ date, balance }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const points = compress(ordered);

  return {
    points,
    rowsRead,
    skipped,
    accountLabels: [...labels].sort(),
    first: points[0],
    last: points[points.length - 1],
  };
}

export function readBalanceCSV(text: string): { header: string[]; rows: string[][]; hasHeader: boolean } {
  const all = parseCSV(text);
  if (!all.length) return { header: [], rows: [], hasHeader: false };
  // a header row is one whose date cell doesn't parse as a date
  const hasHeader = !all[0].some((cell) => parseDate(cell));
  return { header: all[0], rows: hasHeader ? all.slice(1) : all, hasHeader };
}

/** Liabilities are stored negative, so amounts-owed files need flipping. */
export const defaultNegate = (type: Account["type"]): boolean =>
  ["credit", "loan", "mortgage", "other_liability"].includes(type);

export function mergeHistory(
  existing: BalancePoint[],
  incoming: BalancePoint[],
  mode: "merge" | "replace",
): BalancePoint[] {
  const map = new Map<string, number>();
  if (mode === "merge") for (const p of existing) map.set(p.date, p.balance);
  for (const p of incoming) map.set(p.date, p.balance);
  return [...map.entries()]
    .map(([date, balance]) => ({ date, balance }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}
