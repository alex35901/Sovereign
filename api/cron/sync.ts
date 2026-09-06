import type { IncomingMessage, ServerResponse } from "node:http";
import type { DB } from "../../src/types.js";
import { mergeSync, syncWindowStart } from "../../src/lib/sync/merge.js";
import { startOfDayUnix, toPayload } from "../../src/lib/sync/simplefin.js";
import type { BridgeResponse } from "../../src/lib/sync/simplefin.js";
import { fetchAccountsText } from "../_simplefin.js";
import { fetchItemRaw, identifyItem, plaidCreds } from "../_plaid.js";
import type { QueuedPayload } from "../../src/lib/sync/types.js";
import { toPlaidPayload } from "../../src/lib/sync/plaid.js";
import type { SyncResponse } from "../../src/lib/sync/plaid.js";
import type { PlaidCreds } from "../_plaid.js";
import type { PlaidItemRef } from "../../src/types.js";
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

/**
 * When to stop starting another bank.
 *
 * The function is killed at 60 seconds with nothing written, so a fifth Plaid
 * item that would run past the end costs the four before it their whole pull.
 * Whatever has landed by here is written and the rest is named as skipped —
 * tomorrow's run picks them up, and the merge is idempotent either way.
 */
const BUDGET_MS = 45_000;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const deadline = Date.now() + BUDGET_MS;
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
      const tokens = plaidTokens();
      if (!accessUrl && !tokens.length) {
        return send(200, {
          ran: false,
          reason: "This document is encrypted, so the scheduled pull cannot read the credentials inside it and "
            + "needs its own copy. Add SIMPLEFIN_ACCESS_URL, or PLAID_ACCESS_TOKENS for Plaid connections, to the "
            + "Vercel environment variables — Settings shows the values.",
        });
      }

      const pub = stored.doc.pub;
      const since = new Date(Date.now() - 45 * 24 * 60 * 60_000).toISOString().slice(0, 10);
      const ids: number[] = [];
      const errors: string[] = [];
      let accounts = 0;
      let transactions = 0;

      // Sealed to the public key the envelope carries and left for the next
      // browser to open. Nothing this job holds can read any of it back.
      const queue = async (payload: QueuedPayload) => {
        ids.push(await queuePull(await sealTo(pub, JSON.stringify(payload))));
        accounts += payload.accounts.length;
        transactions += payload.transactions.length;
        errors.push(...payload.errors);
      };

      if (accessUrl) {
        const raw = await fetchAccountsText(accessUrl, startOfDayUnix(since));
        await queue({ ...toPayload(JSON.parse(raw) as BridgeResponse), source: "simplefin" });
      }

      // Plaid the same way, one queued pull per item. The tokens have to come
      // from the environment for the same reason SimpleFIN's URL does: they
      // live in a document this job cannot read.
      const creds = tokens.length ? plaidCreds() : null;
      if (tokens.length && !creds) {
        errors.push("PLAID_ACCESS_TOKENS is set but PLAID_CLIENT_ID and PLAID_SECRET are not.");
      }
      let skipped = 0;
      for (const accessToken of creds ? tokens : []) {
        if (Date.now() > deadline) { skipped += 1; continue; }
        try {
          // The kind is not knowable from a bare token, so holdings are always
          // asked for; an item without the investments product simply answers
          // with none.
          const mark = await identifyItem(creds!, accessToken);
          await queue({
            ...await pullItem(creds!, { ...mark, accessToken, kind: "investment" }, since),
            source: "plaid",
          });
        } catch (err) {
          errors.push(err instanceof Error ? err.message : "A Plaid pull failed.");
        }
      }
      if (skipped) errors.push(`${skipped} Plaid connection${skipped === 1 ? "" : "s"} ran out of time and will be pulled tomorrow.`);

      const trimmed = await trimQueue();
      return send(200, {
        ran: ids.length > 0,
        encrypted: true,
        queued: ids,
        trimmed,
        accounts,
        transactions,
        errors,
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

    // Plaid, item by item, on the same schedule and into the same merge. It
    // runs after SimpleFIN rather than beside it because the two can hold the
    // same account, and the later write should be the one with the later
    // window — not whichever promise happened to settle second.
    const plaid = await refreshPlaid(next, deadline);
    next = plaid.db;

    // Prices ride along with the balances, so a morning glance at the app has
    // both moved together rather than one of them a day behind the other.
    const priced = await refreshPrices(next);
    next = priced.db;

    // What actually happened, and separately whether the document moved at all:
    // a run that only recorded a failed provider still has something to save,
    // and is still a run that did nothing worth reporting as success.
    const ran = Boolean(banks) || plaid.ran || priced.ran;

    // Read-then-write with no version guard: this job is the only writer on its
    // schedule, and a browser that saves mid-run will simply win with its own
    // newer copy, which already contains everything this pull would have added.
    // Always a write now, because the proof-of-life stamp above is one.
    const write = await writeDoc(next, null, "scheduled sync");

    return send(bankError ? 502 : 200, {
      ran,
      reason: ran
        ? undefined
        : (priced.error ?? bankError ?? plaid.errors[0]
          ?? "No bank is connected and there was nothing to price."),
      version: write?.stored?.version,
      // Both providers land in the same document, so the totals are the run's
      // rather than one provider's — with the split underneath for a morning
      // when only one of them answered.
      transactionsAdded: (banks?.transactions ?? 0) + plaid.transactions,
      accountsUpdated: (banks?.updated ?? 0) + plaid.accountsUpdated,
      accountsAdded: (banks?.added ?? 0) + plaid.accountsAdded,
      simplefin: banks ? { ...banks, error: bankError ?? undefined } : undefined,
      plaid: plaid.items || plaid.errors.length
        ? {
          items: plaid.items,
          transactions: plaid.transactions,
          accountsAdded: plaid.accountsAdded,
          accountsUpdated: plaid.accountsUpdated,
          holdings: plaid.holdings,
          skipped: plaid.skipped,
          errors: plaid.errors,
        }
        : undefined,
      pricesUpdated: priced.updated,
      pricesMissed: priced.misses,
      priceError: priced.error,
      error: bankError ?? undefined,
      errors: [...(banks?.errors ?? []), ...plaid.errors],
    });
  } catch (err) {
    return send(502, { ran: false, error: err instanceof Error ? err.message : "The scheduled sync failed." });
  }
}

/**
 * Access tokens for a document this job cannot read.
 *
 * Comma-, space- or newline-separated, so pasting a column out of a notes file
 * works as well as a single line. Never logged and never returned: each one
 * authorises every read of one person's bank.
 */
function plaidTokens(): string[] {
  return (process.env.PLAID_ACCESS_TOKENS ?? "")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * The Plaid half of the scheduled run.
 *
 * One item at a time, and an item that fails does not stop the rest: a login
 * that has expired at one bank should not cost the other four their sync. The
 * window is the same one the browser uses, so the overnight pull and a pull
 * you ask for by hand cover the same days.
 *
 * The institution's mark is left alone here. Filling it in is the browser's
 * job — it is a nicety, it costs two more calls per item, and this run has a
 * deadline to keep.
 */
export async function refreshPlaid(db: DB, deadline: number): Promise<{
  db: DB;
  /** Anything actually landed. */
  ran: boolean;
  /** Items pulled, which is not the same as items connected. */
  items: number;
  transactions: number;
  accountsAdded: number;
  accountsUpdated: number;
  holdings: number;
  /** Items left for tomorrow because the run was out of time. */
  skipped: number;
  errors: string[];
}> {
  const idle = {
    db, ran: false, items: 0, transactions: 0,
    accountsAdded: 0, accountsUpdated: 0, holdings: 0, skipped: 0, errors: [] as string[],
  };

  const items = db.settings?.plaidItems ?? [];
  if (!items.length) return idle;

  const creds = plaidCreds();
  if (!creds) {
    return {
      ...idle,
      db: meter(db, "plaid", "ever", {
        error: "Plaid is connected in this document but the deployment has no PLAID_CLIENT_ID and PLAID_SECRET.",
      }),
      errors: ["Plaid isn't configured on the server: add PLAID_CLIENT_ID and PLAID_SECRET to the Vercel environment variables."],
    };
  }

  const out = { ...idle, db };
  for (const item of items) {
    if (Date.now() > deadline) {
      out.skipped += 1;
      continue;
    }
    try {
      const payload = await pullItem(creds, item, syncWindowStart(out.db));
      const merged = mergeSync(out.db, payload, "plaid");
      const stamped = (merged.db.settings.plaidItems ?? []).map((i) =>
        i.itemId === item.itemId ? { ...i, lastSyncAt: payload.fetchedAt } : i);
      out.db = { ...merged.db, settings: { ...merged.db.settings, plaidItems: stamped } };
      out.items += 1;
      out.transactions += merged.transactionsAdded;
      out.accountsAdded += merged.accountsAdded;
      out.accountsUpdated += merged.accountsUpdated;
      out.holdings += merged.holdingsUpdated;
      out.errors.push(...payload.errors.map((e) => `${item.institution}: ${e}`));
    } catch (err) {
      out.errors.push(`${item.institution}: ${err instanceof Error ? err.message : "the sync failed"}`);
    }
  }
  if (out.skipped) {
    out.errors.push(`${out.skipped} more connection${out.skipped === 1 ? "" : "s"} ran out of time and will be pulled tomorrow.`);
  }

  out.ran = out.transactions > 0 || out.accountsAdded > 0 || out.holdings > 0;
  // Recorded once for the run rather than once per item, or the last bank to
  // succeed would clear the expired login of the first and the integrations
  // table would call the whole thing healthy.
  out.db = meter(out.db, "plaid", "ever", { error: out.errors[0] });
  return out;
}

/** One item's raw response, mapped the same way the browser maps it. */
async function pullItem(
  creds: PlaidCreds,
  item: Pick<PlaidItemRef, "accessToken" | "kind" | "institution" | "logo" | "domain">,
  since: string,
) {
  const raw = await fetchItemRaw(creds, {
    accessToken: item.accessToken,
    startDate: since,
    endDate: new Date().toISOString().slice(0, 10),
    withHoldings: item.kind === "investment",
  });
  return toPlaidPayload(raw as unknown as SyncResponse, item);
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
