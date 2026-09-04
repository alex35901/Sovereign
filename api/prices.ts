import type { IncomingMessage, ServerResponse } from "node:http";
import { fetchQuotes } from "./_prices.js";

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

interface Body { apiKey?: string; tickers?: unknown }

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
  if (!Array.isArray(body.tickers) || !body.tickers.length) {
    return send(400, { error: "No tickers were supplied." });
  }

  const result = await fetchQuotes(apiKey, body.tickers);
  // A miss on some symbols is an ordinary answer; only a bad key or a spent
  // allowance is a failure, and those are the caller's to explain.
  if (result.fatal) return send(result.status ?? 502, { error: result.fatal });

  return send(200, { quotes: result.quotes, misses: result.misses });
}
