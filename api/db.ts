import type { IncomingMessage, ServerResponse } from "node:http";
import { bearer, passphraseOk, passphraseSet } from "./_auth";
import { connectionString, readDoc, writeDoc } from "./_store";

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

  if (!connectionString()) {
    return send(503, {
      configured: false,
      error: "No database yet. Add one in Vercel under Storage, then redeploy — it sets DATABASE_URL for you.",
    });
  }
  if (!passphraseSet()) {
    return send(503, {
      configured: false,
      error: "Set SYNC_PASSPHRASE in your Vercel environment variables and redeploy. It is the passphrase this app will ask for.",
    });
  }
  if (!passphraseOk(bearer(req.headers.authorization))) {
    return send(401, { error: "That passphrase doesn't match." });
  }

  try {
    if (req.method === "GET") {
      const stored = await readDoc();
      return send(200, stored ? { found: true, ...stored } : { found: false });
    }

    if (req.method === "PUT" || req.method === "POST") {
      const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as {
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
    return send(500, { error: err instanceof Error ? err.message : "The database request failed." });
  }
}
