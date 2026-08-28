import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Server-side proxy for RentCast property valuations.
 *
 * Same reasoning as api/simplefin.ts: no CORS from the provider, and the API
 * key should not be sitting in a request the page can be tricked into making.
 * The key is held by the client and passed per call — nothing is stored here.
 *
 * Signature note: Vercel invokes the default export as (req, res). A Web-style
 * handler is called the same way and silently never responds.
 */
export const config = { runtime: "nodejs", maxDuration: 30 };

const UPSTREAM_TIMEOUT_MS = 15_000;
const RENTCAST_AVM = "https://api.rentcast.io/v1/avm/value";

type ApiRequest = IncomingMessage & { body?: unknown };
type ApiResponse = ServerResponse;

interface Body { apiKey?: string; address?: string }

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
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
  const address = (body.address ?? "").trim();
  if (!apiKey) return send(400, { error: "No RentCast API key was supplied." });
  if (!address) return send(400, { error: "No address was supplied." });

  try {
    const url = new URL(RENTCAST_AVM);
    url.searchParams.set("address", address);
    const upstream = await fetch(url, {
      headers: { "X-Api-Key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await upstream.text();

    if (!upstream.ok) return send(upstream.status === 429 ? 429 : 502, { error: describe(upstream.status, text) });

    let parsed: { price?: number; priceRangeLow?: number; priceRangeHigh?: number };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return send(502, { error: "RentCast returned something that wasn't JSON." });
    }
    if (typeof parsed.price !== "number") {
      return send(404, { error: "RentCast has no valuation for that address. Check the format: street, city, state, ZIP." });
    }

    return send(200, {
      price: parsed.price,
      priceRangeLow: parsed.priceRangeLow,
      priceRangeHigh: parsed.priceRangeHigh,
      address,
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return send(504, {
      error: timedOut
        ? "RentCast didn't respond within 15 seconds. Try again in a minute."
        : err instanceof Error ? err.message : "Upstream request failed",
    });
  }
}

/** Turns RentCast's status codes into something worth reading. */
function describe(status: number, body: string): string {
  if (status === 401 || status === 403) return "RentCast rejected the API key. Check it in Settings — it's the key from app.rentcast.io, not your password.";
  if (status === 404) return "RentCast has no record of that address. Try the full format: street, city, state, ZIP.";
  if (status === 429) return "You've used all 50 free RentCast lookups this month. The count resets at the start of next month.";
  return `RentCast returned ${status}: ${body.slice(0, 200)}`;
}
