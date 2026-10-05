import { useCallback, useEffect, useRef, useState } from "react";
import type { ISODate } from "../types.js";
import { today } from "./date.js";
import type { PriceHistory } from "./benchmarks.js";
import { emptyHistory, fetchHistories, historyFloor, mergeCloses, needsFetch } from "./benchmarks.js";
import { loadHistory, saveHistory } from "./benchmark-store.js";

export type FetchState = "idle" | "loading" | "error" | "nokey";

/**
 * Closing prices for a set of symbols, from this browser and the wire.
 *
 * The cache answers first and the chart draws immediately from whatever is
 * already there, however old; the fetch only ever fills in what is missing.
 * That matters because the window moves with the range pills, and a reader
 * flicking between 1M and 5Y should not watch the lines empty themselves.
 */
export function useHistories(tickers: readonly string[], apiKey: string) {
  const [data, setData] = useState<Record<string, PriceHistory>>({});
  const [state, setState] = useState<FetchState>("idle");
  /**
   * What went wrong, where the provider said.
   *
   * A spent allowance and a rejected token are the two failures a reader can
   * do something about, and both arrive here as a sentence from the server.
   * Collapsing them into a flag threw the sentence away and left the page
   * saying "some closing prices could not be fetched" about a rate limit that
   * clears itself in an hour.
   */
  const [reason, setReason] = useState<string | null>(null);
  // Which symbols are already in flight, so a second render does not spend a
  // second request on an answer that is already on its way.
  const busy = useRef<Set<string>>(new Set());
  const key = tickers.join(",");

  const load = useCallback(async (symbols: string[]) => {
    if (!symbols.length) { setState("idle"); return; }

    const cached: Record<string, PriceHistory> = {};
    for (const t of symbols) cached[t] = loadHistory(t);
    setData((cur) => ({ ...cur, ...cached }));

    const short = symbols.filter((t) => needsFetch(cached[t], historyFloor(), today()));
    if (!short.length) { setState("idle"); setReason(null); return; }
    if (!apiKey.trim()) { setState("nokey"); return; }

    const fresh = short.filter((t) => !busy.current.has(t));
    if (!fresh.length) return;
    for (const t of fresh) busy.current.add(t);
    // Only a symbol with nothing behind it puts the card into a waiting state:
    // one already drawn from cache should not blink while its tail arrives.
    setState(fresh.some((t) => !cached[t].dates.length) ? "loading" : "idle");

    // Symbols wanting the same window travel together. Most do: either they
    // are all new, or they all need the same few days on the end.
    const byWindow = new Map<string, { from: ISODate; to: ISODate; tickers: string[] }>();
    for (const t of fresh) {
      const want = needsFetch(cached[t], historyFloor(), today());
      if (!want) { busy.current.delete(t); continue; }
      const key = `${want.from}|${want.to}`;
      const bucket = byWindow.get(key) ?? { ...want, tickers: [] };
      bucket.tickers.push(t);
      byWindow.set(key, bucket);
    }

    let empty = false;
    let stopped: string | null = null;
    for (const { from, to, tickers: batch } of byWindow.values()) {
      // A request that failed outright failed for a reason that is about the
      // key or the allowance, not about one symbol, so the windows behind it
      // would fail the same way. Grinding through them spends what is left of
      // a limited hour on answers nobody will get.
      if (stopped) { for (const t of batch) busy.current.delete(t); continue; }
      try {
        const rows = await fetchHistories(apiKey, batch, from, to);
        const at = new Date().toISOString();
        const merged: Record<string, PriceHistory> = {};
        for (const t of batch) {
          const next = mergeCloses(cached[t].dates.length ? cached[t] : emptyHistory(t), rows[t] ?? [], at);
          // Stamped even when the provider had nothing new, or a quiet market
          // puts the page into a request loop.
          saveHistory(next);
          if (!next.dates.length) empty = true;
          merged[t] = next;
        }
        setData((cur) => ({ ...cur, ...merged }));
      } catch (err) {
        stopped = err instanceof Error && err.message
          ? err.message
          : "Closing prices could not be fetched.";
      } finally {
        for (const t of batch) busy.current.delete(t);
      }
    }
    setReason(stopped);
    setState(stopped || empty ? "error" : "idle");
  }, [apiKey]);

  useEffect(() => {
    void load(key ? key.split(",") : []);
  }, [key, load]);

  return { data, state, reason };
}

