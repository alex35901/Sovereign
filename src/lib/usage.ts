/**
 * How much of each provider's free tier has been spent.
 *
 * Every integration here sits on an allowance — fifty valuations a month, five
 * hundred symbols a month, ten institutions — and the failure mode they share
 * is silence: the allowance runs out, calls start being refused, and the app
 * goes on showing yesterday's figures as though they were today's. So the
 * counting is deliberate rather than a side effect, and it is kept in the
 * document so it follows the budget between devices.
 *
 * Counts reset by period rather than being decayed or swept: a meter carries
 * the period it belongs to, and a read from a later period sees zero. Nothing
 * has to run at midnight for that to be right.
 */

import type { DB } from "../types.js";

/** What the provider's ceiling is measured against. */
export type Period = "day" | "month" | "ever";

export interface Meter {
  /** The period this count belongs to. Empty when the ceiling never resets. */
  period: string;
  count: number;
  /**
   * Distinct things counted, for a ceiling measured in those rather than in
   * calls — Tiingo charges by the symbol, however often it is asked about.
   */
  seen?: string[];
  /** When the provider was last called, successfully or not. */
  at?: string;
  /** What went wrong last time. Cleared by the next success. */
  error?: string;
}

export type Usage = Record<string, Meter>;

/** Distinct things worth remembering per period, so a meter can't grow forever. */
const SEEN_CAP = 600;

export const EMPTY: Meter = { period: "", count: 0 };

export function periodKey(period: Period, now: number = Date.now()): string {
  if (period === "ever") return "";
  const iso = new Date(now).toISOString();
  return period === "day" ? iso.slice(0, 10) : iso.slice(0, 7);
}

/**
 * The meter as it stands now — zeroed if its period has rolled over.
 *
 * Reading is where the reset happens, so a month that passes with the app shut
 * still starts the new one at zero.
 */
export function meterOf(usage: Usage | undefined, id: string, period: Period, now: number = Date.now()): Meter {
  const m = usage?.[id];
  if (!m) return EMPTY;
  return m.period === periodKey(period, now) ? m : { ...EMPTY, at: m.at, error: m.error };
}

/**
 * Records one call to a provider.
 *
 * `calls` is what to add; `distinct` is for the providers that charge per
 * symbol rather than per request, where asking about the same twenty tickers
 * every morning costs twenty and not six hundred. An `error` is remembered
 * until the next run clears it, which is what the health column reads.
 */
export function noteRun(
  usage: Usage | undefined,
  id: string,
  period: Period,
  outcome: { calls?: number; distinct?: readonly string[]; error?: string },
  now: number = Date.now(),
): Usage {
  const key = periodKey(period, now);
  const prior = usage?.[id];
  const carried = prior && prior.period === key ? prior : null;

  let seen = carried?.seen;
  let count = carried?.count ?? 0;

  if (outcome.distinct) {
    const set = new Set(seen ?? []);
    for (const d of outcome.distinct) {
      if (set.size >= SEEN_CAP) break;
      set.add(d);
    }
    seen = [...set];
    // The count and the set are the same measure for these providers; keeping
    // both in step means a reader never has to know which kind it is holding.
    count = seen.length;
  } else {
    count += outcome.calls ?? 1;
  }

  const next: Meter = {
    period: key,
    count,
    at: new Date(now).toISOString(),
    ...(seen ? { seen } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };

  return { ...(usage ?? {}), [id]: next };
}

/**
 * Records a run into the document, without spending an undo slot.
 *
 * Every integration calls this on both paths — the success clears the last
 * error, which is the only thing that ever does. Passing no label is
 * deliberate: nobody wants "undo: counted a call" sitting on top of the edit
 * they actually want back.
 */
export function recordRun(
  apply: (fn: (cur: DB) => DB, label?: string) => void,
  id: string,
  period: Period,
  outcome: { calls?: number; distinct?: readonly string[]; error?: string },
): void {
  apply((cur) => ({
    ...cur,
    settings: { ...cur.settings, usage: noteRun(cur.settings.usage, id, period, outcome) },
  }));
}

/** An error worth storing: short, and never a stack trace. */
export const reason = (err: unknown, fallback: string): string => {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return (text.trim() || fallback).slice(0, 160);
};
