import type { IncomingMessage, ServerResponse } from "node:http";
import { bearer, passphraseOk, passphraseSet } from "./_auth.js";
import { callerKey, clearFailures, lockedFor, lockedOutNow, noteFailure, readAttempt, waitMessage } from "./_ratelimit.js";
import { diagnose, findConnection, readDoc, writeDoc } from "./_store.js";

type ApiRequest = IncomingMessage & { body?: unknown };

/**
 * The budget document: GET to load it, PUT to save it.
 *
 * Every device talks to this, which is what makes the same budget appear
 * wherever it is opened.
 */
export const config = { runtime: "nodejs", maxDuration: 30 };

export default async function handler(req: ApiRequest, res: ServerResponse): Promise<void> {
  const send = (status: number, data: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(data));
  };

  // The passphrase gate comes first, so nothing below can be probed anonymously.
  if (!passphraseSet()) {
    return send(503, {
      configured: false,
      error: "Set SYNC_PASSPHRASE in your Vercel environment variables and redeploy. It is the passphrase this app will ask for.",
    });
  }
  // Best effort on purpose: the limiter lives in the same database the document
  // does, so if it cannot be reached there is nothing here worth guessing at
  // anyway — every path below fails at the data step. Failing closed would
  // turn a database blip into a lockout with no way back in.
  const key = callerKey("db", req.headers);
  let limited = true;
  // Kept from this read so the success path below can skip a pointless DELETE
  // on every ordinary request — by far the common case is no row at all.
  let seen = null;
  try {
    seen = await readAttempt(key);
    const wait = lockedFor(seen, Date.now());
    if (wait > 0) {
      res.setHeader("retry-after", String(wait));
      return send(429, { error: waitMessage(wait), retryAfter: wait });
    }
  } catch {
    limited = false;
  }

  if (!passphraseOk(bearer(req.headers.authorization))) {
    if (limited) {
      try {
        const wait = await noteFailure(key);
        if (wait > 0) {
          res.setHeader("retry-after", String(wait));
          return send(429, { error: waitMessage(wait), retryAfter: wait });
        }
      } catch { /* the counter is not worth failing the response over */ }
    }
    return send(401, { error: "That passphrase doesn't match." });
  }
  // Right answer: forget the wrong ones, so an honest typo costs nothing later.
  if (limited && seen) await clearFailures(key).catch(() => {});

  try {
    // Answered before the database is required, because a missing or unusable
    // connection is precisely what this is asked to explain. Gating it behind
    // that check would make it useless in the only case that needs it.
    const body0 = (typeof req.body === "string" ? safeParse(req.body) : req.body) as { action?: string } | undefined;
    if (req.method === "POST" && body0?.action === "diagnose") {
      const lockedOut = await lockedOutNow().catch(() => null);
      return send(200, { ...(await diagnose()), passphraseSet: true, lockedOut });
    }

    const conn = findConnection();
    if (!conn.url) {
      return send(503, {
        configured: false,
        error: conn.unusable
          ? `${conn.unusable.name} is a ${conn.unusable.scheme}: URL, which isn't a Postgres connection this app can open. Neon and Supabase give a postgres:// URL; Prisma Postgres gives an accelerate URL, which won't work here.`
          : "No database yet. Add one in Vercel under Storage, then redeploy — it sets DATABASE_URL for you.",
      });
    }

    if (req.method === "GET") {
      const stored = await readDoc();
      return send(200, stored ? { found: true, ...stored } : { found: false });
    }

    if (req.method === "PUT" || req.method === "POST") {
      const body = (typeof req.body === "string" ? safeParse(req.body) : req.body) as {
        doc?: unknown; baseVersion?: number; device?: string;
      } | undefined;
      if (!body || body.doc === undefined) return send(400, { error: "No document supplied." });
      if (typeof body.baseVersion !== "number" || body.baseVersion < 0) {
        return send(400, { error: "A baseVersion is required so a stale write can be refused." });
      }

      const result = await writeDoc(body.doc, body.baseVersion, body.device?.slice(0, 60) || "a browser");
      if (!result.ok) {
        return send(409, {
          error: "This budget was changed somewhere else. Reload to pick up that copy.",
          current: result.conflict ?? null,
        });
      }
      return send(200, { version: result.stored?.version, updatedAt: result.stored?.updatedAt });
    }

    return send(405, { error: "GET or PUT only" });
  } catch (err) {
    // Always JSON, always this app's shape: a raw throw would reach the browser
    // as the platform's HTML error page, which says nothing useful.
    const e = err as { message?: string; code?: string };
    const code = typeof e?.code === "string" ? ` (${e.code})` : "";
    return send(500, {
      error: `${e?.message ? String(e.message) : "The database request failed."}${code}`,
      hint: "Settings → Sync across devices → Check the database says which part failed.",
    });
  }
}

const safeParse = (raw: string): unknown => {
  try { return JSON.parse(raw); } catch { return undefined; }
};
