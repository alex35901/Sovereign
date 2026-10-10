import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_HISTORY, fetchHistory, fetchQuotes } from "./_prices.js";

/**
 * Server-side proxy for Tiingo end-of-day prices.
 *
 * Same reasoning as api/property.ts: no CORS from the provider, and the API
 * key should not be sitting in a request the page can be tricked into making.
 * The key is held by the client and passed per call — nothing is stored here.
 *
 * Signature note: Vercel invokes the default export as (req, res). A Web-style
 * handler is called the same way and silently never responds.
 */
export const config = { runtime: "nodejs", maxDuration: 60 };

type ApiRequest = IncomingMessage & { body?: unknown };

interface Body {
  apiKey?: string;
  tickers?: unknown;
  /** Symbols to fetch a window of closes for, instead of a single quote. */
  history?: unknown;
  from?: unknown;
  to?: unknown;
}

export default async function handler(req: ApiRequest, res: ServerResponse): Promise<void> {
  const send = (status: number, data: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  };

  if (req.method !== "POST") return send(405, { error: "POST only" });

  let body: Body;
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Body;
    if (!body || typeof body !== "object") throw new Error("empty body");
  } catch {
    return send(400, { error: "Malformed JSON body" });
  }

  const apiKey = (body.apiKey ?? "").trim();
  if (!apiKey) return send(400, { error: "No Tiingo API key was supplied." });

  // Two questions, one endpoint, because they are the same provider and the
  // same key: "what is this worth now" and "what has it been worth". They are
  // told apart by which field is present rather than by a mode flag, so a
  // caller cannot ask for both and get half an answer.
  if (Array.isArray(body.history) && body.history.length) {
    const from = typeof body.from === "string" ? body.from : "";
    const to = typeof body.to === "string" ? body.to : "";
    if (!from || !to) return send(400, { error: "A history request needs a from and a to date." });

    const want = body.history.filter((t): t is string => typeof t === "string").slice(0, MAX_HISTORY);
    const out: Record<string, { date: string; close: number }[]> = {};
    /**
     * The symbols actually asked about, answer or no answer.
     *
     * Not the same as the ones with rows: a provider that has never heard of a
     * money-market fund answers with nothing, and that is an answer worth
     * remembering so nobody spends another request learning it again. A symbol
     * the run never reached is a different thing entirely and must not be
     * recorded as having been asked.
     */
    const asked: string[] = [];
    let error: string | undefined;
    for (const ticker of want) {
      const r = await fetchHistory(apiKey, ticker, from, to);
      /*
       * Stop, but keep what the earlier symbols cost.
       *
       * This used to return the error and nothing else. The requests already
       * spent on the symbols before it had been paid for out of an allowance
       * of fifty an hour, their answers were thrown away, and the browser
       * cached nothing — so the next visit asked for exactly the same symbols
       * and threw them away again at exactly the same point. A reader with
       * more positions than the allowance never saw a single comparison line,
       * for ever, while every hour's allowance went on answers nobody kept.
       *
       * The run still stops: what failed is the key or the allowance, so every
       * symbol behind it would fail the same way.
       */
      if (r.fatal) { error = r.fatal; break; }
      asked.push(r.ticker);
      if (r.rows.length) out[r.ticker] = r.rows;
    }
    // Two hundred with the reason inside it, rather than a status that throws
    // away the body: the rows above are real and the reason is worth reading,
    // and the caller needs both in the same answer.
    return send(200, error ? { history: out, asked, error } : { history: out, asked });
  }

  if (!Array.isArray(body.tickers) || !body.tickers.length) {
    return send(400, { error: "No tickers were supplied." });
  }

  const result = await fetchQuotes(apiKey, body.tickers);
  // A miss on some symbols is an ordinary answer; only a bad key or a spent
  // allowance is a failure, and those are the caller's to explain.
  if (result.fatal) return send(result.status ?? 502, { error: result.fatal });

  return send(200, { quotes: result.quotes, misses: result.misses });
}
