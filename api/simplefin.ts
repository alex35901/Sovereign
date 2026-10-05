import type { IncomingMessage, ServerResponse } from "node:http";
import { claim, fetchAccounts } from "./_simplefin.js";

/**
 * Server-side proxy for a SimpleFIN bridge.
 *
 * Same reasoning as the other provider proxies: no CORS from the bridge, and
 * an access URL carries basic-auth credentials in it, so the request is made
 * from here rather than from the page. Nothing is stored. The access URL
 * belongs to the household, lives in their encrypted document, and arrives
 * with each call.
 *
 * Signature note: Vercel invokes the default export as (req, res). A Web-style
 * handler is called the same way and silently never responds.
 */
export const config = { runtime: "nodejs", maxDuration: 60 };

type ApiRequest = IncomingMessage & { body?: unknown };

interface Body {
  /** Exchange this one-use token for an access URL. */
  setupToken?: unknown;
  /** Or pull with an access URL already held. */
  accessUrl?: unknown;
  from?: unknown;
  to?: unknown;
}

const isDay = (d: unknown): d is string =>
  typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00.000Z`));

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

  // Two questions, told apart by which field is present rather than by a mode
  // flag, so a caller cannot ask for both and get half an answer.
  if (typeof body.setupToken === "string" && body.setupToken.trim()) {
    const out = await claim(body.setupToken);
    if ("error" in out) return send(out.status ?? 502, { error: out.error });
    return send(200, out);
  }

  if (typeof body.accessUrl !== "string" || !body.accessUrl.trim()) {
    return send(400, { error: "No SimpleFIN access URL was supplied." });
  }
  if (!isDay(body.from) || !isDay(body.to)) {
    return send(400, { error: "A pull needs a from and a to date." });
  }

  const out = await fetchAccounts(
    body.accessUrl,
    new Date(`${body.from}T00:00:00.000Z`),
    // The protocol excludes its end second, so the window runs to the end of
    // the day asked for rather than to its first moment.
    new Date(`${body.to}T23:59:59.000Z`),
  );
  if ("error" in out) return send(out.status ?? 502, { error: out.error });
  return send(200, out);
}
