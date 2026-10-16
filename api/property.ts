import type { IncomingMessage, ServerResponse } from "node:http";
import { claimRequest } from "./_meter.js";
import { connectionString } from "./_store.js";

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

/**
 * The most this app will spend at RentCast in a calendar month, whatever asks
 * it to.
 *
 * Well under the free tier's fifty, because the schedule needs a dozen and the
 * rest is there to be pressed by hand. Raise it with RENTCAST_MONTHLY_CAP if
 * the plan behind the key is a larger one; this is a ceiling on the app, not
 * an opinion about the plan.
 *
 * Counted in the database, so it holds across every device, tab and window at
 * once. Without a database there is nowhere to count, and the app falls back
 * to the browser's own ceiling rather than refusing to value anything: a
 * household running this without Postgres is one browser, which is the case
 * the browser's count is already right about.
 */
const DEFAULT_MONTHLY_CAP = 24;

function monthlyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RENTCAST_MONTHLY_CAP);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MONTHLY_CAP;
  return Math.floor(raw);
}

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

  // Before the money is spent, and only where there is somewhere to count it.
  // A refusal here costs nothing and says what it is, which is the opposite of
  // what the provider's own refusal does at the end of a billing period.
  const cap = monthlyCap();
  /** What the server has counted this month, for the browser to catch up to. */
  let spent: number | undefined;
  if (connectionString()) {
    try {
      const claim = await claimRequest("rentcast", cap);
      spent = claim.spent;
      if (!claim.allowed) {
        return send(429, {
          error: `This app has spent its ${claim.cap} RentCast lookups for the month, so it stopped before asking for another. `
            + "The count resets on the first of the month. Raise RENTCAST_MONTHLY_CAP to allow more.",
        });
      }
    } catch {
      // A database that is asleep, unreachable or has never had this table is
      // not a reason to stop valuing property. The browser's own ceiling still
      // applies, and it is the one that was there before this.
    }
  }

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
      // The count that cannot be lost, handed back so the browser's own can be
      // corrected to it. A browser that spent a lookup whose record was
      // dropped by a merge would otherwise go on believing it has more of the
      // month left than it does.
      spent,
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
  if (status === 401 || status === 403) return "RentCast rejected the API key. Check it in Settings: it is the key from app.rentcast.io, not your password.";
  if (status === 404) return "RentCast has no record of that address. Try the full format: street, city, state, ZIP.";
  if (status === 429) return "RentCast is refusing further requests: the plan's monthly limit is spent. It resets when the billing period does.";
  return `RentCast returned ${status}: ${body.slice(0, 200)}`;
}
