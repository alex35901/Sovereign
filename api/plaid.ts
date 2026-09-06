import type { IncomingMessage, ServerResponse } from "node:http";
import type { PlaidEnv } from "./_plaid.js";
import { PlaidError, fetchItemRaw, identifyItem, plaidCall, plaidCreds, plaidEnv } from "./_plaid.js";

/**
 * Server-side proxy for Plaid.
 *
 * Unlike SimpleFIN and RentCast, Plaid's credentials must never reach the
 * browser: client_id and secret authorise every request for every item, so they
 * live in environment variables and are read in _plaid.ts, which this shares
 * with the scheduled sync. The per-item access token is held by the client and
 * passed back in, the same as the SimpleFIN access URL.
 *
 * Signature note: Vercel invokes the default export as (req, res). A Web-style
 * handler is called the same way and silently never responds.
 */
export const config = { runtime: "nodejs", maxDuration: 60 };

type ApiRequest = IncomingMessage & { body?: unknown };
type ApiResponse = ServerResponse;

interface DiagnoseBody { action: "diagnose" }
interface LinkTokenBody { action: "link_token"; products?: string[] }
interface ExchangeBody { action: "exchange"; publicToken: string }
interface InstitutionBody { action: "institution"; accessToken: string }
interface SyncBody { action: "sync"; accessToken: string; startDate: string; endDate: string; withHoldings?: boolean }
type Body = DiagnoseBody | LinkTokenBody | ExchangeBody | InstitutionBody | SyncBody;


export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const send = (status: number, data: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  };

  if (req.method !== "POST") return send(405, { error: "POST only" });

  const creds = plaidCreds();
  if (!creds) {
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

  const call = (path: string, payload: Record<string, unknown>, on: PlaidEnv = plaidEnv()) =>
    plaidCall(creds, path, payload, on);

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

      const here = plaidEnv();
      const there: PlaidEnv = here === "production" ? "sandbox" : "production";
      const probe = await tryEnv(here);
      // If the keys are refused, the useful question is which environment they
      // DO belong to — that turns a dead end into a one-line instruction.
      const elsewhere = probe.error === "INVALID_API_KEYS" ? await tryEnv(there) : { ok: false, error: null };
      const worksIn: PlaidEnv | null = probe.ok ? here : elsewhere.ok ? there : null;

      return send(200, {
        environment: here,
        envVarSet: Boolean(process.env.PLAID_ENV),
        clientId: { length: creds.clientId.length, trimmed: creds.rawClientId !== creds.clientId },
        secret: { length: creds.secret.length, trimmed: creds.rawSecret !== creds.secret },
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
      return send(200, { linkToken: data.link_token, environment: plaidEnv() });
    }

    const identify = (accessToken: string) => identifyItem(creds, accessToken);

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
      const raw = await fetchItemRaw(creds, {
        accessToken: body.accessToken,
        startDate: body.startDate,
        endDate: body.endDate,
        withHoldings: body.withHoldings,
      });
      return send(200, {
        accounts: raw.accounts,
        transactions: raw.transactions,
        // Said out loud rather than left to be noticed: a window this app
        // could not read to the end of is a window with transactions missing.
        total: raw.total,
        truncated: raw.truncated,
        holdings: raw.holdings,
        securities: raw.securities,
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
