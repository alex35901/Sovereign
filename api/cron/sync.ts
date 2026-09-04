import type { IncomingMessage, ServerResponse } from "node:http";
import type { DB } from "../../src/types.js";
import { mergeSync, syncWindowStart } from "../../src/lib/sync/merge.js";
import { startOfDayUnix, toPayload } from "../../src/lib/sync/simplefin.js";
import type { BridgeResponse } from "../../src/lib/sync/simplefin.js";
import { fetchAccountsText } from "../_simplefin.js";
import { fetchQuotes } from "../_prices.js";
import { applyQuotes, pricesDue, tickersOf, toQuoteMap } from "../../src/lib/prices.js";
import { noteRun } from "../../src/lib/usage.js";
import { connectionString, queuePull, readDoc, trimQueue, writeDoc } from "../_store.js";
import { isEnvelope, sealTo } from "../../src/lib/crypto.js";
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

    // An encrypted document cannot be merged into here, and must not be
    // touched: writing a merge over an envelope would destroy it. Instead the
    // pull is encrypted to the public key the envelope carries and left in the
    // queue for the next browser that opens the app. Nothing this job holds
    // can read it back afterwards.
    if (isEnvelope(stored.doc)) {
      const accessUrl = (process.env.SIMPLEFIN_ACCESS_URL ?? "").trim();
      if (!accessUrl) {
        return send(200, {
          ran: false,
          reason: "This document is encrypted, so the scheduled pull needs its own copy of the SimpleFIN "
            + "access URL. Add SIMPLEFIN_ACCESS_URL to the Vercel environment variables — Settings shows the value.",
        });
      }
      const since = new Date(Date.now() - 45 * 24 * 60 * 60_000).toISOString().slice(0, 10);
      const raw = await fetchAccountsText(accessUrl, startOfDayUnix(since));
      const payload = toPayload(JSON.parse(raw) as BridgeResponse);
      const id = await queuePull(await sealTo(stored.doc.pub, JSON.stringify(payload)));
      const trimmed = await trimQueue();

      return send(200, {
        ran: true,
        encrypted: true,
        queued: id,
        trimmed,
        accounts: payload.accounts.length,
        transactions: payload.transactions.length,
        errors: payload.errors,
      });
    }

    const db = stored.doc as DB;
    const accessUrl = db.settings?.simplefinAccessUrl;

    // Proof of life. A scheduled job that quietly stops running looks exactly
    // like a quiet week, and nothing else in the document would show the
    // difference — so the run stamps itself whether or not it finds anything.
    let next = meter(db, "vercel", "month", {});
    let banks: { added: number; updated: number; transactions: number; errors: string[] } | null = null;
    let bankError: string | null = null;

    if (accessUrl) {
      try {
        // Straight to the bridge: the browser proxy exists only for CORS, and a
        // relative URL would not resolve from here anyway.
        const raw = await fetchAccountsText(accessUrl, startOfDayUnix(syncWindowStart(next)));
        const payload = toPayload(JSON.parse(raw) as BridgeResponse);
        const merged = mergeSync(next, payload, "simplefin");
        next = merged.db;
        banks = {
          added: merged.accountsAdded,
          updated: merged.accountsUpdated,
          transactions: merged.transactionsAdded,
          errors: payload.errors,
        };
      } catch (err) {
        // Held rather than thrown: a bridge that is down should not also cost
        // the day's prices. The run still answers 502 so the failure shows up
        // in the deployment's log rather than passing for a quiet success.
        bankError = err instanceof Error ? err.message : "The SimpleFIN pull failed.";
      }
      next = meter(next, "simplefin", "ever", { error: bankError ?? banks?.errors[0] });
    }

    // Prices ride along with the balances, so a morning glance at the app has
    // both moved together rather than one of them a day behind the other.
    const priced = await refreshPrices(next);
    next = priced.db;

    // What actually happened, and separately whether the document moved at all:
    // a run that only recorded a failed provider still has something to save,
    // and is still a run that did nothing worth reporting as success.
    const ran = Boolean(banks) || priced.ran;

    // Read-then-write with no version guard: this job is the only writer on its
    // schedule, and a browser that saves mid-run will simply win with its own
    // newer copy, which already contains everything this pull would have added.
    // Always a write now, because the proof-of-life stamp above is one.
    const write = await writeDoc(next, null, "scheduled sync");

    return send(bankError ? 502 : 200, {
      ran,
      reason: ran
        ? undefined
        : (priced.error ?? bankError ?? "SimpleFIN isn't connected and there was nothing to price."),
      version: write?.stored?.version,
      transactionsAdded: banks?.transactions ?? 0,
      accountsUpdated: banks?.updated ?? 0,
      accountsAdded: banks?.added ?? 0,
      pricesUpdated: priced.updated,
      pricesMissed: priced.misses,
      priceError: priced.error,
      error: bankError ?? undefined,
      errors: banks?.errors ?? [],
    });
  } catch (err) {
    return send(502, { ran: false, error: err instanceof Error ? err.message : "The scheduled sync failed." });
  }
}

/**
 * The price half of the scheduled run.
 *
 * Kept separate from the SimpleFIN pull so a provider that is down, or a key
 * that has been revoked, costs the other half nothing: whichever side answers
 * still gets written. The key comes from the document, falling back to the
 * environment for a deployment that keeps it there.
 */
async function refreshPrices(db: DB): Promise<{
  db: DB;
  /** Prices actually landed. */
  ran: boolean;
  updated: number;
  misses: string[];
  error?: string;
}> {
  const idle = { db, ran: false, updated: 0, misses: [] };

  const key = (db.settings?.tiingoApiKey ?? process.env.TIINGO_API_KEY ?? "").trim();
  if (!key) return idle;
  if (db.settings?.priceAutoRefresh === false) return idle;
  if (!pricesDue(db.settings?.lastPricesAt)) return idle;

  const tickers = tickersOf(db.holdings ?? []);
  if (!tickers.length) return idle;

  const raw = await fetchQuotes(key, tickers);
  // A bad key or a spent allowance must not stamp lastPricesAt: doing so would
  // put the next run a day away from noticing the problem had cleared. The
  // meter still records it, which is what puts it in the integrations table.
  if (raw.fatal) {
    return {
      db: meter(db, "tiingo", "month", { error: raw.fatal }),
      ran: false, updated: 0, misses: [], error: raw.fatal,
    };
  }

  const { quotes, misses } = toQuoteMap(raw.quotes, raw.misses);
  const applied = applyQuotes(db, quotes, new Date().toISOString());
  return {
    db: meter(applied.db, "tiingo", "month", { distinct: tickers }),
    ran: true, updated: applied.updated, misses,
  };
}

/** The same meter the browser keeps, written by the job that runs without one. */
function meter(
  db: DB,
  id: string,
  period: "day" | "month" | "ever",
  outcome: { calls?: number; distinct?: readonly string[]; error?: string },
): DB {
  return { ...db, settings: { ...db.settings, usage: noteRun(db.settings?.usage, id, period, outcome) } };
}
