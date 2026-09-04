import type { DB, Holding } from "../types.js";
import { postJSON } from "./api.js";
import { isSymbol } from "./symbol.js";
import { reason, recordRun } from "./usage.js";

/**
 * Keeping holding prices current.
 *
 * Prices used to be typed in by hand, which is fine for a position you check
 * once a quarter and useless for a portfolio you look at daily. Tiingo quotes
 * the previous session's close for stocks, ETFs and — the part that matters
 * for a 401(k) — mutual funds. See api/_prices.ts for why that provider.
 *
 * Two rules make this safe to run unattended:
 *
 *   - a symbol the provider doesn't know keeps whatever price it already has,
 *     so a private ticker or a stable-value fund is never zeroed; and
 *   - only holdings whose price actually moved are rewritten, so a quiet day
 *     doesn't churn the document or the sync that follows it.
 */

/** A quote, in cents per share, as it is stored. */
export interface Quote {
  price: number;
  /** The session the price closed on, YYYY-MM-DD. */
  asOf: string;
}

export interface PriceOutcome {
  /** Holdings whose price changed. */
  updated: number;
  /** Symbols the provider had nothing for. */
  misses: string[];
  /** How many symbols were asked about at all. */
  asked: number;
}

/** Tiingo's free tier allows 50 requests an hour, and one symbol is one request. */
export const MAX_TICKERS = 40;

/**
 * Distinct symbols the free tier allows in a month.
 *
 * Distinct, not requests: asking about the same twenty tickers every morning
 * costs twenty for the month, not six hundred. Which is why the meter in
 * lib/usage.ts counts a set rather than a tally for this one.
 */
export const MONTHLY_SYMBOLS = 500;

/**
 * Prices are refreshed no more often than this, however many syncs run.
 *
 * A day's close only changes once a day, so anything shorter spends the
 * allowance to write the same number back. Wide enough that several devices
 * and several tabs together stay well inside the hourly limit.
 */
export const MIN_GAP_HOURS = 6;

/** The distinct symbols worth asking about, upper-cased. */
export function tickersOf(holdings: readonly Holding[]): string[] {
  const out = new Set<string>();
  for (const h of holdings) {
    const t = h.ticker.trim().toUpperCase();
    if (isSymbol(t)) out.add(t);
    if (out.size >= MAX_TICKERS) break;
  }
  return [...out];
}

const stamp = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** Whether a refresh is owed. */
export function pricesDue(lastPricesAt: string | undefined, now: number = Date.now()): boolean {
  const last = stamp(lastPricesAt);
  if (last === null) return true;
  if (last > now) return false; // a clock that jumped; don't stampede
  return now - last >= MIN_GAP_HOURS * 3_600_000;
}

/**
 * Writes quotes onto the holdings that carry those symbols.
 *
 * `at` is the moment of the run, not the session date: it is what the schedule
 * reads, and it is stamped even when nothing moved so a market holiday doesn't
 * put the app into a retry loop.
 */
export function applyQuotes(
  db: DB,
  quotes: Record<string, Quote>,
  at: string,
): { db: DB; updated: number } {
  let updated = 0;
  const holdings = db.holdings.map((h) => {
    const q = quotes[h.ticker.trim().toUpperCase()];
    if (!q || q.price <= 0 || q.price === h.price) return h;
    updated += 1;
    return { ...h, price: q.price };
  });

  return {
    db: {
      ...db,
      holdings: updated ? holdings : db.holdings,
      settings: { ...db.settings, lastPricesAt: at },
    },
    updated,
  };
}

/* ── talking to the provider ──────────────────────────────────────────── */

/** What the provider hands back, in dollars. */
export interface RawQuote { ticker: string; price: number; asOf: string }
interface ProxyResult { quotes: RawQuote[]; misses: string[] }

/**
 * Dollars to cents, keyed by symbol.
 *
 * Shared with the scheduled run in api/cron/sync.ts, which reaches the same
 * provider without going through the browser proxy. A symbol that came back
 * unpriceable joins the misses rather than writing a zero over a price
 * somebody typed in.
 */
export function toQuoteMap(
  raw: readonly RawQuote[] | undefined,
  misses: readonly string[] | undefined,
): { quotes: Record<string, Quote>; misses: string[] } {
  const quotes: Record<string, Quote> = {};
  const out = [...(misses ?? [])];
  for (const q of raw ?? []) {
    const cents = Number.isFinite(q.price) && q.price > 0 ? Math.round(q.price * 100) : 0;
    if (cents > 0) quotes[q.ticker.trim().toUpperCase()] = { price: cents, asOf: q.asOf };
    else out.push(q.ticker);
  }
  return { quotes, misses: out };
}

/** Quotes for these symbols, keyed by symbol. Prices come back in cents. */
export async function fetchQuotes(
  apiKey: string,
  tickers: string[],
): Promise<{ quotes: Record<string, Quote>; misses: string[] }> {
  if (!apiKey.trim()) throw new Error("Add your Tiingo API key in Settings first.");
  if (!tickers.length) return { quotes: {}, misses: [] };

  const raw = await postJSON<ProxyResult>("/api/prices", { apiKey: apiKey.trim(), tickers });
  return toQuoteMap(raw.quotes, raw.misses);
}

/**
 * One refresh, merged in. Shared by the Investments button and the scheduler
 * so the two can't drift apart.
 *
 * `label` is what the undo stack shows. Left off for the automatic run: an
 * undo entry nobody asked for would push a real edit off the end of the stack.
 */
export async function refreshPrices(
  db: DB,
  apply: (fn: (cur: DB) => DB, label?: string) => void,
  label?: string,
): Promise<PriceOutcome> {
  const apiKey = db.settings.tiingoApiKey ?? "";
  if (!apiKey.trim()) throw new Error("Add your Tiingo API key in Settings first.");

  const tickers = tickersOf(db.holdings);
  if (!tickers.length) return { updated: 0, misses: [], asked: 0 };

  let quotes: Record<string, Quote>;
  let misses: string[];
  try {
    ({ quotes, misses } = await fetchQuotes(apiKey, tickers));
  } catch (err) {
    // Recorded before rethrowing, so the integrations table can say what is
    // wrong even though every caller here swallows the failure quietly.
    recordRun(apply, "tiingo", "month", { error: reason(err, "The price refresh failed.") });
    throw err;
  }
  const at = new Date().toISOString();

  // Whether to spend an undo slot at all. A quiet day writes nothing but the
  // timestamp, and offering to undo that would push a real edit off the end of
  // a twelve-deep stack.
  const moves = db.holdings.some((h) => {
    const q = quotes[h.ticker.trim().toUpperCase()];
    return Boolean(q) && q.price > 0 && q.price !== h.price;
  });

  let updated = 0;
  apply((cur) => {
    const res = applyQuotes(cur, quotes, at);
    updated = res.updated;
    return res.db;
  }, moves ? label : undefined);

  // Tiingo bills by the distinct symbol over a month, so that is what the
  // meter holds: the same twenty tickers every morning cost twenty, not six
  // hundred. A symbol it had nothing for was still asked about, so it counts.
  recordRun(apply, "tiingo", "month", { distinct: tickers });

  return { updated, misses, asked: tickers.length };
}

/** "3 prices updated" / "prices already current" */
export function priceSummary(o: PriceOutcome): string {
  if (!o.asked) return "No tickers to price.";
  if (!o.updated) return "Prices already current.";
  return `${o.updated} price${o.updated === 1 ? "" : "s"} updated.`;
}
