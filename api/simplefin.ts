import type { VercelRequest, VercelResponse } from "@vercel/node";

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

/** Upstream calls get a bounded wait so a stalled bridge can't hang the client. */
const UPSTREAM_TIMEOUT_MS = 15_000;

interface ClaimBody { action: "claim"; setupToken: string }
interface AccountsBody { action: "accounts"; accessUrl: string; startDate: number }

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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
      const claimUrl = Buffer.from(body.setupToken, "base64").toString("utf8").trim();
      if (!/^https:\/\//.test(claimUrl)) {
        return send(400, { error: "That setup token doesn't decode to an https URL. Copy the whole token — they're long and easy to truncate." });
      }
      const upstream = await fetch(claimUrl, {
        method: "POST",
        headers: { "content-length": "0" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const accessUrl = (await upstream.text()).trim();
      if (!upstream.ok || !/^https:\/\//.test(accessUrl)) {
        return send(400, {
          error: `Bridge rejected the token (${upstream.status}). Setup tokens are single-use — generate a fresh one, and check the bridge shows an active subscription or trial.`,
        });
      }
      return send(200, { accessUrl });
    }

    if (body.action === "accounts") {
      const url = new URL(body.accessUrl);
      if (url.protocol !== "https:") return send(400, { error: "Access URL must be https." });
      const auth = "Basic " + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64");
      url.username = "";
      url.password = "";
      const target = new URL(`${url.toString().replace(/\/$/, "")}/accounts`);
      target.searchParams.set("start-date", String(body.startDate));
      const upstream = await fetch(target, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const text = await upstream.text();
      if (!upstream.ok) return send(502, { error: `Bridge returned ${upstream.status}: ${text.slice(0, 300)}` });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(text);
      return;
    }

    return send(400, { error: "Unknown action" });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return send(504, {
      error: timedOut
        ? "SimpleFIN didn't respond within 15 seconds. It may be busy — try again in a minute."
        : err instanceof Error ? err.message : "Upstream request failed",
    });
  }
}
