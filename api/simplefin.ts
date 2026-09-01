import type { IncomingMessage, ServerResponse } from "node:http";
import { BridgeError, claim, fetchAccountsText } from "./_simplefin.js";

/**
 * Vercel's request/response objects are Node's own, plus a parsed `body`.
 * Typing them structurally keeps @vercel/node (and 150 packages) out of the
 * install, and out of the build's way.
 */
type ApiRequest = IncomingMessage & { body?: unknown };
type ApiResponse = ServerResponse;

/**
 * Server-side proxy for SimpleFIN Bridge.
 *
 * Two reasons this can't live in the browser: the bridge sends no CORS headers,
 * and the access URL carries HTTP Basic credentials, which fetch() refuses to
 * send cross-origin. Credentials are never stored here — the client holds the
 * access URL and passes it in per request.
 *
 * Note the signature. On a non-Next project Vercel invokes the default export
 * as (req, res); a Web-style `(request: Request) => Response` handler is called
 * the same way, so it silently never writes a response and the request hangs
 * until the platform times it out.
 */
export const config = { runtime: "nodejs", maxDuration: 30 };

interface ClaimBody { action: "claim"; setupToken: string }
interface AccountsBody { action: "accounts"; accessUrl: string; startDate: number }

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const send = (status: number, data: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  };

  if (req.method !== "POST") return send(405, { error: "POST only" });

  let body: ClaimBody | AccountsBody;
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as ClaimBody | AccountsBody;
    if (!body || typeof body !== "object") throw new Error("empty body");
  } catch {
    return send(400, { error: "Malformed JSON body" });
  }

  try {
    if (body.action === "claim") {
      return send(200, { accessUrl: await claim(body.setupToken) });
    }

    if (body.action === "accounts") {
      const text = await fetchAccountsText(body.accessUrl, body.startDate);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(text);
      return;
    }

    return send(400, { error: "Unknown action" });
  } catch (err) {
    if (err instanceof BridgeError) return send(err.status, { error: err.message });
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return send(504, {
      error: timedOut
        ? "SimpleFIN didn't respond within 15 seconds. It may be busy — try again in a minute."
        : err instanceof Error ? err.message : "Upstream request failed",
    });
  }
}
