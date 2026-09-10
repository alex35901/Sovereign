import type { PriceHistory } from "./benchmarks.js";
import { emptyHistory } from "./benchmarks.js";

/**
 * Where benchmark closing prices are kept, and why it is not the document.
 *
 * Everything else this app holds is the user's own: it goes in the document,
 * it is encrypted before it leaves the browser, and the server genuinely
 * cannot read it. A benchmark's closing prices are none of those things. They
 * are public, they are identical for every user of the app, and they are
 * re-fetchable in one request per symbol.
 *
 * Putting them in the document would mean six years of daily closes for three
 * symbols riding on every save, for data that says nothing about anybody. So
 * they live in this browser's own storage instead: nothing to encrypt, nothing
 * to sync, nothing added to the wire. The cost is that a new device fetches
 * its own copy, which is three requests against an allowance of five hundred
 * symbols a month.
 *
 * Every read and write is guarded. A private window, cleared site data, or a
 * browser set to refuse storage all throw here rather than returning empty,
 * and a chart is not worth failing a page over.
 */

const KEY = "sovereign.benchmarks.v1";

interface Stored { v: 1; series: Record<string, PriceHistory> }

/** Everything cached, or nothing if storage is unavailable or unreadable. */
export function loadHistories(): Record<string, PriceHistory> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Stored;
    if (!parsed || parsed.v !== 1 || typeof parsed.series !== "object") return {};
    const out: Record<string, PriceHistory> = {};
    for (const [ticker, h] of Object.entries(parsed.series)) {
      // A half-written or hand-edited entry is dropped rather than trusted:
      // the two arrays are read in lockstep everywhere downstream.
      if (!h || !Array.isArray(h.dates) || !Array.isArray(h.closes)) continue;
      if (h.dates.length !== h.closes.length) continue;
      out[ticker] = { ...h, ticker };
    }
    return out;
  } catch {
    return {};
  }
}

/** One symbol's cached history, or an empty one. */
export function loadHistory(ticker: string): PriceHistory {
  return loadHistories()[ticker] ?? emptyHistory(ticker);
}

/** Writes one symbol back. Silent on failure, deliberately. */
export function saveHistory(h: PriceHistory): void {
  try {
    const series = loadHistories();
    series[h.ticker] = h;
    localStorage.setItem(KEY, JSON.stringify({ v: 1, series } satisfies Stored));
  } catch {
    // Out of quota, or storage refused. The chart still draws from what is in
    // memory for this session; the next visit simply fetches again.
  }
}

/** Forgets everything cached. For the settings screen and for tests. */
export function clearHistories(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
