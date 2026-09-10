import type { ISODate } from "../types.js";
import { addDays, toISO, parseISO } from "./date.js";
import { postJSON } from "./api.js";

/**
 * Comparing a portfolio against the market.
 *
 * A balance chart answers "what is it worth"; it cannot answer "was that any
 * good", because a quarter where everything rose 8% and a quarter where
 * everything fell 8% draw the same shape when only one line is on the page.
 * So a benchmark's closing prices are put on the same axis, both rebased to
 * where the period opened, and the gap between the two lines is the answer.
 *
 * Where this history lives is the interesting decision, and it is deliberately
 * NOT the document. See lib/benchmark-store.ts.
 */

export interface Benchmark {
  key: string;
  label: string;
  /** What is actually fetched. A fund that tracks the thing, since an index
   *  itself has no price a data provider will sell you on a free tier. */
  ticker: string;
  tone: string;
}

/**
 * The three Monarch offers, and the funds that stand in for them.
 *
 * Total-return funds rather than the raw indices: SPY, VTI and BND all have
 * adjusted closes going back further than anybody's brokerage account, and an
 * adjusted close already carries reinvested dividends — which is what makes
 * the comparison fair against a portfolio that also collects them.
 */
export const BENCHMARKS: Benchmark[] = [
  { key: "sp500", label: "S&P 500", ticker: "SPY", tone: "--c2" },
  { key: "stocks", label: "US Stocks", ticker: "VTI", tone: "--c4" },
  { key: "bonds", label: "US Bonds", ticker: "BND", tone: "--c5" },
];

export const benchmarkFor = (key: string): Benchmark | undefined =>
  BENCHMARKS.find((b) => b.key === key);

/**
 * One symbol's closing prices, oldest first.
 *
 * Two parallel arrays rather than an array of objects: this is a few thousand
 * readings and `{"date":"2026-09-10","close":56712}` spends forty characters
 * on the same twelve characters of information.
 */
export interface PriceHistory {
  ticker: string;
  /** Trading days, oldest first, no duplicates. */
  dates: ISODate[];
  /** Adjusted closes in cents, one per date. */
  closes: number[];
  /** When this was last brought up to date, ISO. */
  fetchedAt: string;
}

/** How far back to reach on a first fetch. Long enough to outlast "5 years". */
export const HISTORY_YEARS = 6;

/**
 * How long a history is left alone before its tail is asked for again.
 *
 * A close only lands once a day, and between Friday's and Monday's there is
 * nothing to ask for. Without this the last date would sit behind today all
 * weekend and every visit would spend a request learning that.
 */
export const HISTORY_MIN_GAP_HOURS = 12;

/** An empty history for a symbol, so callers need not special-case absence. */
export const emptyHistory = (ticker: string): PriceHistory =>
  ({ ticker, dates: [], closes: [], fetchedAt: "" });

/**
 * Existing readings plus new ones, oldest first, one per day.
 *
 * A later reading for a day already held replaces it: an adjusted close is
 * restated backwards whenever a dividend is paid, so the newest answer for an
 * old day is the right one.
 */
export function mergeCloses(
  existing: PriceHistory,
  rows: readonly { date: ISODate; close: number }[],
  at: string,
): PriceHistory {
  const by = new Map<ISODate, number>();
  for (let i = 0; i < existing.dates.length; i++) by.set(existing.dates[i], existing.closes[i]);
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    if (!Number.isFinite(r.close) || r.close <= 0) continue;
    by.set(r.date, Math.round(r.close));
  }
  const dates = [...by.keys()].sort();
  return { ticker: existing.ticker, dates, closes: dates.map((d) => by.get(d)!), fetchedAt: at };
}

/**
 * The close on a date, or the last one before it.
 *
 * Markets are shut at weekends and the chart is not, so a Sunday reads
 * Friday's price. Null before the history starts, because a line has to begin
 * where its data does rather than at a flat guess.
 */
export function closeOn(h: PriceHistory, date: ISODate): number | null {
  if (!h.dates.length || date < h.dates[0]) return null;
  let lo = 0;
  let hi = h.dates.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (h.dates[mid] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best < 0 ? null : h.closes[best];
}

/**
 * A benchmark rebased to where the period opened, as a fraction.
 *
 * The same shape the portfolio's own line gets: `(v - v0) / v0`. Rebased on
 * the first sampled day the history actually covers, not on the first sampled
 * day, so an account older than the fund's listing still gets a line — it just
 * starts later, with nulls in front of it.
 */
export function returnSeries(h: PriceHistory, dates: readonly ISODate[]): (number | null)[] {
  const closes = dates.map((d) => closeOn(h, d));
  const base = closes.find((c) => c !== null && c > 0) ?? null;
  if (base === null) return dates.map(() => null);
  return closes.map((c) => (c === null || c <= 0 ? null : (c - base) / base));
}

/** The same rebasing, for a series already in hand. */
export function rebase(values: readonly number[]): number[] {
  const base = values.find((v) => v !== 0) ?? 0;
  if (!base) return values.map(() => 0);
  return values.map((v) => (v - base) / base);
}

/**
 * What still has to be asked for, if anything.
 *
 * Three cases, and the middle one is why this is a function rather than a
 * comparison at the call site: a history that starts after the window wanted
 * cannot be extended backwards a day at a time, and a provider charges by the
 * request rather than by the span, so the whole window is asked for again.
 */
export function needsFetch(
  h: PriceHistory | undefined,
  from: ISODate,
  to: ISODate,
  now: number = Date.now(),
): { from: ISODate; to: ISODate } | null {
  if (!h || !h.dates.length) return { from, to };
  if (h.dates[0] > from) return { from, to };

  const last = h.dates[h.dates.length - 1];
  if (last >= to) return null;

  // Held off until the current answer is stale, or a weekend spends a request
  // every visit learning that Friday is still the most recent close.
  const at = Date.parse(h.fetchedAt);
  if (Number.isFinite(at) && at <= now && now - at < HISTORY_MIN_GAP_HOURS * 3_600_000) return null;

  return { from: addDays(last, 1), to };
}

/** The earliest day worth asking about, given how far back the app can look. */
export function historyFloor(now: Date = new Date()): ISODate {
  const d = new Date(now.getTime());
  d.setFullYear(d.getFullYear() - HISTORY_YEARS);
  return toISO(d);
}

/** Whether a date string is one this module will accept at all. */
export const isDay = (d: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(parseISO(d).getTime());

/* ── talking to the provider ──────────────────────────────────────────── */

interface HistoryResponse { history?: Record<string, { date: string; close: number }[]> }

/**
 * Closes for one symbol over a window, in cents.
 *
 * Through the same proxy the quotes go through, for the same two reasons: the
 * provider sends no CORS headers, and the key should never be in a request the
 * page could be talked into making.
 */
export async function fetchHistory(
  apiKey: string,
  ticker: string,
  from: ISODate,
  to: ISODate,
): Promise<{ date: ISODate; close: number }[]> {
  const res = await postJSON<HistoryResponse>("/api/prices", {
    apiKey: apiKey.trim(), history: [ticker], from, to,
  });
  const rows = res.history?.[ticker.toUpperCase()] ?? [];
  return rows
    .filter((r) => isDay(r.date) && Number.isFinite(r.close) && r.close > 0)
    .map((r) => ({ date: r.date, close: Math.round(r.close * 100) }));
}
