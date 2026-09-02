import type { IncomingMessage, ServerResponse } from "node:http";
import type { DB } from "../../src/types.js";
import { mergeSync, syncWindowStart } from "../../src/lib/sync/merge.js";
import { startOfDayUnix, toPayload } from "../../src/lib/sync/simplefin.js";
import type { BridgeResponse } from "../../src/lib/sync/simplefin.js";
import { fetchAccountsText } from "../_simplefin.js";
import { connectionString, readDoc, writeDoc } from "../_store.js";
import { bearer, passphraseOk, secretOk } from "../_auth.js";
import { callerKey, clearFailures, lockedFor, noteFailure, readAttempt, waitMessage } from "../_ratelimit.js";

/**
 * The scheduled pull, run by Vercel on the timetable in vercel.json.
 *
 * This is the piece that works with every browser shut: it reads the stored
 * document, pulls from SimpleFIN using the same merge the app uses, and writes
 * the result back. Opening the app on any device then shows current figures
 * without waiting for a fetch.
 */
/** A slow bridge plus a large merge needs more than the default 10 seconds. */
export const config = { runtime: "nodejs", maxDuration: 60 };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, data: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  };

  // Vercel sends CRON_SECRET as a bearer token when the variable is set. The
  // sync passphrase is accepted too, so the run can be triggered by hand.
  const token = bearer(req.headers.authorization);
  const cronSecret = (process.env.CRON_SECRET ?? "").trim();

  if (!connectionString()) return send(503, { error: "No database configured." });

  // Two secrets open this door, so it is worth the same limit the document
  // endpoint has. Vercel's own run always carries the right one and so never
  // accumulates against it.
  const key = callerKey("cron", req.headers);
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

  if (!(secretOk(cronSecret, token) || passphraseOk(token))) {
    if (limited) {
      try {
        const wait = await noteFailure(key);
        if (wait > 0) {
          res.setHeader("retry-after", String(wait));
          return send(429, { error: waitMessage(wait), retryAfter: wait });
        }
      } catch { /* the counter is not worth failing the response over */ }
    }
    return send(401, { error: "Not authorised." });
  }
  if (limited && seen) await clearFailures(key).catch(() => {});

  try {
    const stored = await readDoc();
    if (!stored) return send(200, { ran: false, reason: "Nothing saved yet — open the app once to seed it." });

    const db = stored.doc as DB;
    const accessUrl = db.settings?.simplefinAccessUrl;
    if (!accessUrl) return send(200, { ran: false, reason: "SimpleFIN isn't connected." });

    // Straight to the bridge: the browser proxy exists only for CORS, and a
    // relative URL would not resolve from here anyway.
    const raw = await fetchAccountsText(accessUrl, startOfDayUnix(syncWindowStart(db)));
    const payload = toPayload(JSON.parse(raw) as BridgeResponse);
    const merged = mergeSync(db, payload, "simplefin");

    // Read-then-write with no version guard: this job is the only writer on its
    // schedule, and a browser that saves mid-run will simply win with its own
    // newer copy, which already contains everything this pull would have added.
    const write = await writeDoc(merged.db, null, "scheduled sync");

    return send(200, {
      ran: true,
      version: write.stored?.version,
      transactionsAdded: merged.transactionsAdded,
      accountsUpdated: merged.accountsUpdated,
      accountsAdded: merged.accountsAdded,
      errors: payload.errors,
    });
  } catch (err) {
    return send(502, { ran: false, error: err instanceof Error ? err.message : "The scheduled sync failed." });
  }
}
