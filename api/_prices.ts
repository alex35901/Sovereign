/**
 * End-of-day share prices from Tiingo.
 *
 * Shared by /api/prices and the scheduled run in api/cron/sync.ts for the same
 * reason api/_simplefin.ts is: the browser needs a proxy for CORS, the cron job
 * has no browser to proxy through, and both must agree on what a price is.
 *
 * Tiingo rather than the alternatives because a retirement account is mostly
 * mutual funds, and Tiingo's free tier is the one that quotes them alongside
 * stocks and ETFs. That tier allows 500 distinct symbols a month, 50 requests
 * an hour and 1,000 a day; there is no batch endpoint, so one holding is one
 * request and the hourly limit is the binding one.
 */

import { isSymbol } from "../src/lib/symbol.js";

const TIINGO = "https://api.tiingo.com/tiingo/daily";
const TIMEOUT_MS = 10_000;

/** One ticker is one request, and the free tier allows 50 an hour. */
export const MAX_TICKERS = 40;

/** Sent a few at a time: a wide fan-out trips the limiter that a queue doesn't. */
const WAVE = 4;

/** One resolved symbol. `price` is in dollars — cents are the caller's job. */
export interface Quote {
  ticker: string;
  price: number;
  /** The session the price closed on, YYYY-MM-DD. */
  asOf: string;
}

export interface QuoteResult {
  quotes: Quote[];
  /**
   * Symbols Tiingo had nothing for — a private ticker, a stable-value fund, a
   * typo. Their stored price is left exactly as it was rather than zeroed.
   */
  misses: string[];
  /** Set when the run failed as a whole: a bad key, or the hourly limit. */
  fatal?: string;
  /** What to answer with when `fatal` is set. */
  status?: number;
}

/** Upper-cased, deduped, filtered to real symbols and capped at the hourly limit. */
export function cleanTickers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const up = t.trim().toUpperCase();
    if (isSymbol(up)) out.add(up);
    if (out.size >= MAX_TICKERS) break;
  }
  return [...out];
}

interface Row { date?: string; close?: number; adjClose?: number }
type Outcome = Quote | { miss: string } | { fatal: string; status: number };

async function one(apiKey: string, ticker: string): Promise<Outcome> {
  const url = `${TIINGO}/${encodeURIComponent(ticker.toLowerCase())}/prices`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Token ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // One symbol timing out is not the run failing: the rest still stand.
    return { miss: ticker };
  }

  // These two are properties of the key, not of the symbol, so every remaining
  // request would fail the same way. Stop rather than spend the allowance.
  if (res.status === 401 || res.status === 403) {
    return {
      status: 401,
      fatal: "Tiingo rejected the API key. Check it in Settings — it's the token from tiingo.com, not your password.",
    };
  }
  if (res.status === 429) {
    return {
      status: 429,
      fatal: "Tiingo's free tier allows 50 requests an hour. Prices will refresh on the next run.",
    };
  }

  const text = await res.text();
  if (!res.ok) return { miss: ticker };

  let rows: Row[];
  try {
    rows = JSON.parse(text) as Row[];
  } catch {
    return { miss: ticker };
  }
  if (!Array.isArray(rows) || !rows.length) return { miss: ticker };

  // Rows come back oldest first, so the last one is the most recent session.
  const last = rows[rows.length - 1];
  // `close` and not `adjClose`: the adjusted series is restated backwards for
  // splits and dividends, which is right for a chart and wrong for valuing the
  // shares actually sitting in the account today.
  const price = typeof last.close === "number" ? last.close : last.adjClose;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return { miss: ticker };

  return { ticker, price, asOf: typeof last.date === "string" ? last.date.slice(0, 10) : "" };
}

/** Quotes for as many of `tickers` as Tiingo knows. Never throws. */
export async function fetchQuotes(apiKey: string, tickers: unknown): Promise<QuoteResult> {
  const key = apiKey.trim();
  if (!key) return { quotes: [], misses: [], fatal: "No Tiingo API key was supplied.", status: 400 };

  const want = cleanTickers(tickers);
  if (!want.length) return { quotes: [], misses: [] };

  const quotes: Quote[] = [];
  const misses: string[] = [];
  let fatal: { fatal: string; status: number } | null = null;

  for (let i = 0; i < want.length && !fatal; i += WAVE) {
    const wave = await Promise.all(want.slice(i, i + WAVE).map((t) => one(key, t)));
    for (const r of wave) {
      if ("fatal" in r) fatal ??= r;
      else if ("miss" in r) misses.push(r.miss);
      else quotes.push(r);
    }
  }

  return fatal ? { quotes, misses, ...fatal } : { quotes, misses };
}
