import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Server-side proxy for Plaid.
 *
 * Unlike SimpleFIN and RentCast, Plaid's credentials must never reach the
 * browser: client_id and secret authorise every request for every item, so they
 * live in environment variables here. The per-item access token is held by the
 * client and passed back in, the same as the SimpleFIN access URL.
 *
 * Signature note: Vercel invokes the default export as (req, res). A Web-style
 * handler is called the same way and silently never responds.
 */
export const config = { runtime: "nodejs", maxDuration: 60 };

const UPSTREAM_TIMEOUT_MS = 25_000;

type ApiRequest = IncomingMessage & { body?: unknown };
type ApiResponse = ServerResponse;

interface DiagnoseBody { action: "diagnose" }
interface LinkTokenBody { action: "link_token"; products?: string[] }
interface ExchangeBody { action: "exchange"; publicToken: string }
interface InstitutionBody { action: "institution"; accessToken: string }
interface SyncBody { action: "sync"; accessToken: string; startDate: string; endDate: string; withHoldings?: boolean }
type Body = DiagnoseBody | LinkTokenBody | ExchangeBody | InstitutionBody | SyncBody;

const CHECK_POINTER = " Press “Check configuration” below to see which one Plaid is refusing.";
type PlaidEnv = "sandbox" | "production";
const env = (): PlaidEnv => (process.env.PLAID_ENV === "sandbox" ? "sandbox" : "production");

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const send = (status: number, data: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  };

  if (req.method !== "POST") return send(405, { error: "POST only" });

  const rawClientId = process.env.PLAID_CLIENT_ID ?? "";
  const rawSecret = process.env.PLAID_SECRET ?? "";
  const clientId = rawClientId.trim();
  const secret = rawSecret.trim();
  if (!clientId || !secret) {
    return send(503, {
      error: "Plaid isn't configured. Add PLAID_CLIENT_ID and PLAID_SECRET as environment variables in your Vercel project, then redeploy.",
      configured: false,
    });
  }

  let body: Body;
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Body;
    if (!body || typeof body !== "object") throw new Error("empty body");
  } catch {
    return send(400, { error: "Malformed JSON body" });
  }

  const call = async (path: string, payload: Record<string, unknown>, on: PlaidEnv = env()) => {
    const upstream = await fetch(`https://${on}.plaid.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, secret, ...payload }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await upstream.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new PlaidError(502, `Plaid returned something that wasn't JSON (${upstream.status}).`);
    }
    if (!upstream.ok) {
      throw new PlaidError(upstream.status, describe(parsed), typeof parsed.error_code === "string" ? parsed.error_code : "");
    }
    return parsed;
  };

  try {
    if (body.action === "diagnose") {
      // Reports the shape of the configuration and what Plaid says about it,
      // without ever returning the credentials themselves.
      const tryEnv = (on: PlaidEnv) =>
        call("/institutions/get", { count: 1, offset: 0, country_codes: ["US"] }, on)
          .then(() => ({ ok: true, error: null }))
          .catch((err: unknown) => {
            // Terse on purpose: the card prints the explanation underneath, so
            // this line only has to say what Plaid itself said.
            if (err instanceof PlaidError) return { ok: false, error: err.code || "the request was refused" };
            return { ok: false, error: err instanceof Error ? err.message : "unknown failure" };
          });

      const here = env();
      const there: PlaidEnv = here === "production" ? "sandbox" : "production";
      const probe = await tryEnv(here);
      // If the keys are refused, the useful question is which environment they
      // DO belong to — that turns a dead end into a one-line instruction.
      const elsewhere = probe.error === "INVALID_API_KEYS" ? await tryEnv(there) : { ok: false, error: null };
      const worksIn: PlaidEnv | null = probe.ok ? here : elsewhere.ok ? there : null;

      return send(200, {
        environment: here,
        envVarSet: Boolean(process.env.PLAID_ENV),
        clientId: { length: clientId.length, trimmed: rawClientId !== clientId },
        secret: { length: secret.length, trimmed: rawSecret !== secret },
        probe,
        worksIn,
      });
    }

    if (body.action === "link_token") {
      const products = body.products?.length ? body.products : ["transactions"];
      const data = await call("/link/token/create", {
        user: { client_user_id: "sovereign-local-user" },
        client_name: "Sovereign",
        products,
        country_codes: ["US"],
        language: "en",
      });
      return send(200, { linkToken: data.link_token, environment: env() });
    }

    /**
     * Who an access token belongs to, and their mark. Neither endpoint is
     * billed per call, so this is safe to ask again for an item connected
     * before the app knew to keep the answer.
     */
    const identify = async (accessToken: string) => {
      const item = await call("/item/get", { access_token: accessToken }).catch(() => null);
      const institutionId = (item?.item as { institution_id?: string } | undefined)?.institution_id;
      let institution = "Connected account";
      let logo: string | undefined;
      let domain: string | undefined;
      if (institutionId) {
        const inst = await call("/institutions/get_by_id", {
          institution_id: institutionId,
          country_codes: ["US"],
          // Plaid withholds the logo, colour and website unless asked.
          options: { include_optional_metadata: true },
        }).catch(() => null);
        const found = inst?.institution as { name?: string; logo?: string; url?: string } | undefined;
        institution = found?.name ?? institution;
        // Base64 PNG straight from Plaid, so no third party ever sees which
        // institutions these are.
        if (found?.logo) logo = `data:image/png;base64,${found.logo}`;
        if (found?.url) domain = hostOf(found.url);
      }
      return { institution, logo, domain };
    };

    if (body.action === "exchange") {
      if (!body.publicToken) return send(400, { error: "No public token supplied." });
      const data = await call("/item/public_token/exchange", { public_token: body.publicToken });
      const who = await identify(data.access_token as string);
      return send(200, { accessToken: data.access_token, itemId: data.item_id, ...who });
    }

    if (body.action === "institution") {
      if (!body.accessToken) return send(400, { error: "No access token supplied." });
      return send(200, await identify(body.accessToken));
    }

    if (body.action === "sync") {
      if (!body.accessToken) return send(400, { error: "No access token supplied." });
      const accounts = await call("/accounts/get", { access_token: body.accessToken });

      const transactions = await call("/transactions/get", {
        access_token: body.accessToken,
        start_date: body.startDate,
        end_date: body.endDate,
        options: { count: 500, offset: 0 },
      }).catch((err: unknown) => {
        // an investment-only item has no transactions product; that isn't fatal
        if (err instanceof PlaidError && err.status === 400) return { transactions: [] };
        throw err;
      });

      let holdings: Record<string, unknown> = { holdings: [], securities: [] };
      if (body.withHoldings) {
        holdings = await call("/investments/holdings/get", { access_token: body.accessToken })
          .catch(() => ({ holdings: [], securities: [] }));
      }

      return send(200, {
        accounts: accounts.accounts,
        transactions: (transactions as { transactions?: unknown[] }).transactions ?? [],
        holdings: holdings.holdings ?? [],
        securities: holdings.securities ?? [],
      });
    }

    return send(400, { error: "Unknown action" });
  } catch (err) {
    if (err instanceof PlaidError) return send(err.status >= 500 ? 502 : err.status, { error: err.message });
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return send(504, {
      error: timedOut
        ? "Plaid didn't respond within 25 seconds. Try again in a minute."
        : err instanceof Error ? err.message : "Upstream request failed",
    });
  }
}

class PlaidError extends Error {
  constructor(public status: number, message: string, public code = "") {
    super(message);
    this.name = "PlaidError";
  }
}

/** "https://www.chase.com/" → "chase.com" */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Plaid's error bodies are structured; turn them into one readable line. */
function describe(body: Record<string, unknown>): string {
  const code = typeof body.error_code === "string" ? body.error_code : "";
  const message = typeof body.error_message === "string" ? body.error_message : "Plaid rejected the request.";
  if (code === "INVALID_API_KEYS") {
    return "Plaid rejected the credentials. The usual cause is a secret from the wrong environment: Plaid issues a separate secret for Sandbox and for Production, and this app talks to Production unless PLAID_ENV says otherwise." + CHECK_POINTER;
  }
  if (code === "ITEM_LOGIN_REQUIRED") return "This connection needs re-authenticating at the bank. Reconnect it below.";
  if (code === "PRODUCTS_NOT_SUPPORTED") return "That institution doesn't offer this data through Plaid. Try connecting it as the other account type.";
  if (code === "NO_INVESTMENT_ACCOUNTS") return "Plaid found no investment accounts on that login.";
  if (code === "RATE_LIMIT_EXCEEDED") return "Plaid is rate-limiting this request. Wait a minute and try again.";
  return code ? `${message} (${code})` : message;
}
