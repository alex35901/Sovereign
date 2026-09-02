import type { DB, ISODate, Transaction, TxnEvent } from "../types.js";
import { fmt } from "./money.js";
import { dateLabel } from "./date.js";

/**
 * A transaction's history: how it arrived, and every change since.
 *
 * Written as words at the moment of the change rather than as raw values, so a
 * line still reads correctly after the category or tag it names is renamed or
 * deleted. The point of a log is to say what happened then, not now.
 */

const SOURCE_LABEL: Record<string, string> = {
  simplefin: "SimpleFIN",
  plaid: "Plaid",
  csv: "a CSV import",
  manual: "you",
};

export const sourceLabel = (source: string | undefined): string =>
  (source && SOURCE_LABEL[source]) || source || "you";

export function added(source: string, at: string): TxnEvent {
  return { at, kind: "added", source: sourceLabel(source) };
}

const money = (cents: number) => fmt(cents, { sign: false });

/** Every tracked field, and how to say its value out loud. */
function describe(db: DB, t: Transaction): Record<string, string> {
  const category = db.categories.find((c) => c.id === t.categoryId)?.name ?? "Uncategorized";
  const account = db.accounts.find((a) => a.id === t.accountId)?.name ?? "an account";
  const tags = t.tags
    .map((id) => db.tags.find((g) => g.id === id)?.name)
    .filter(Boolean)
    .sort()
    .join(", ");
  return {
    Merchant: t.merchant,
    Category: category,
    Amount: money(t.amount),
    Date: dateLabel(t.date, { year: true }),
    Account: account,
    Notes: t.notes?.trim() ?? "",
    Tags: tags,
    Reviewed: t.reviewed ? "yes" : "no",
    "Hidden from reports": t.hideFromReports ? "yes" : "no",
    Split: t.splits?.length ? `${t.splits.length} ways` : "",
  };
}

/** One event per field that actually moved. */
export function changes(db: DB, before: Transaction, after: Transaction, at: string): TxnEvent[] {
  const a = describe(db, before);
  const b = describe(db, after);
  const out: TxnEvent[] = [];
  for (const field of Object.keys(b)) {
    if (a[field] === b[field]) continue;
    out.push({ at, kind: "changed", field, from: a[field] || "none", to: b[field] || "none" });
  }
  return out;
}

/** How many events to keep. Enough to be a history, bounded so it can't grow forever. */
const LIMIT = 60;

/** `after`, with the changes from `before` appended to its history. */
export function record(db: DB, before: Transaction, after: Transaction, at: string): Transaction {
  const events = changes(db, before, after, at);
  if (!events.length) return after;
  return { ...after, activity: [...(after.activity ?? []), ...events].slice(-LIMIT) };
}

/**
 * The history to show, oldest first.
 *
 * A transaction recorded before this existed has no log, so its arrival is
 * reconstructed from what it does carry — better than showing nothing for
 * everything that predates the feature.
 */
export function history(t: Transaction, syncSource?: string): TxnEvent[] {
  const logged = t.activity ?? [];
  if (logged.some((e) => e.kind === "added")) return logged;
  const at = t.createdAt || `${t.date}T00:00:00.000Z`;
  return [added(t.importKey ? syncSource ?? "csv" : syncSource ?? "manual", at), ...logged];
}

/** "Added to Sovereign", "Category changed" — the headline for one line. */
export function eventTitle(e: TxnEvent): string {
  return e.kind === "added" ? "Added to Sovereign" : `${e.field} changed`;
}

export function eventDetail(e: TxnEvent): string {
  if (e.kind === "added") return `by ${e.source ?? "you"}`;
  return `${e.from} → ${e.to}`;
}

/** Timestamps are stored in UTC; shown in whatever zone the reader is in. */
export function eventWhen(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const day = dateLabel(d.toISOString().slice(0, 10) as ISODate, { year: true });
  return `${day} · ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
