import type { RemoteAccount, RemoteTransaction, SyncPayload } from "./types.js";
import { guessAccountType } from "./types.js";
import { postJSON } from "../api.js";
import type { ISODate } from "../../types.js";

/**
 * The SimpleFIN bridge, as this app reads it.
 *
 * A protocol rather than a company: the household authorises their banks at a
 * bridge, the bridge hands over a one-use setup token, and that is exchanged
 * once for an access URL which is the only credential afterwards. There is no
 * application registration, no certificate and nobody to sign up with, which
 * is the whole reason it is here: it is the one route to a bank that does not
 * depend on a vendor still wanting the business.
 *
 * Deliberately a near-copy of the Plaid path rather than an abstraction over
 * it. The two agree about the shape of a payload and almost nothing else: a
 * bridge has no products, no update mode, no holdings, no per-connection
 * health, and no notion of how far back it reaches. A shared runner would be
 * a run of conditionals on which provider it was.
 */

const PROXY = "/api/simplefin";

/**
 * The id every account from the bridge carries, standing for the one
 * connection there is.
 *
 * A household has one bridge and every bank sits behind it, so unlike Plaid
 * there is no per-login id to write down. A constant gives the accounts
 * something to point at, which is what lets "is anything still feeding this
 * account" be a lookup rather than a guess. It rides in the same field a Plaid
 * item id does, because that field is "which connection fed this" and has
 * only ever been read that way.
 */
export const SIMPLEFIN_ID = "simplefin";

/** What a SimpleFIN connection is, once the token has been spent. */
export interface SimplefinRef {
  /** Carries its own basic-auth credentials. The only credential held. */
  accessUrl: string;
  addedAt: string;
  lastSyncAt?: string;
  lastError?: { message: string; at: string };
}

/**
 * The one-use exchange. A setup token in, an access URL out.
 *
 * Done once, when somebody pastes the token. The token cannot be claimed
 * twice, so what comes back has to be kept.
 */
export const claimSetupToken = (setupToken: string): Promise<{ accessUrl: string }> =>
  postJSON<{ accessUrl: string }>(PROXY, { setupToken });

/** What a bridge reports about one account, before it is this app's shape. */
interface RawAccount {
  id?: unknown;
  name?: unknown;
  currency?: unknown;
  balance?: unknown;
  "balance-date"?: unknown;
  org?: { name?: unknown; domain?: unknown; url?: unknown; id?: unknown };
  transactions?: RawTransaction[];
}

interface RawTransaction {
  id?: unknown;
  posted?: unknown;
  transacted_at?: unknown;
  amount?: unknown;
  description?: unknown;
  payee?: unknown;
  memo?: unknown;
  pending?: unknown;
}

const text = (v: unknown, max = 200): string =>
  String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Cents from the protocol's numeric string, without going through a float.
 *
 * The same reading the server does, because the browser maps the payload and
 * the scheduled job maps it too, and a figure that differed between them would
 * be two balances for one account. "0.145" times a hundred is 14.4999…, which
 * rounds to the wrong cent.
 */
export function toCents(raw: unknown): number | null {
  const s = String(raw ?? "").trim().replace(/[,\s]/g, "");
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const frac = (m[3] ?? "").padEnd(3, "0");
  const out = Number(m[2] || "0") * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  return Number.isFinite(out) ? sign * out : null;
}

/** A unix second, as the day it fell on. Absent or nonsense reads as absent. */
function dayOf(v: unknown): ISODate | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * A domain for the bank, from whatever the bridge says about the institution.
 *
 * Only the host, because that is all the logo lookup wants, and only when it
 * parses: an org's url field is free text as far as this app is concerned.
 */
function domainOf(org: RawAccount["org"]): string | undefined {
  const direct = text(org?.domain, 100);
  if (direct) return direct.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || undefined;
  const url = text(org?.url, 200);
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the bridge sent, as a payload the merge understands.
 *
 * Everything is checked rather than trusted, the same way every other number
 * arriving from outside is. An account with no id cannot be re-found on the
 * next pull and is dropped rather than added as a fresh one every night.
 */
export function toPayload(
  raw: { accounts: RawAccount[]; errors: string[] },
  fetchedAt: string,
): SyncPayload {
  const accounts: RemoteAccount[] = [];
  const transactions: RemoteTransaction[] = [];

  for (const a of raw.accounts ?? []) {
    const syncId = text(a.id, 120);
    const balance = toCents(a.balance);
    if (!syncId || balance === null) continue;

    const name = text(a.name, 100) || "Account";
    // The organisation is the bank. A bridge that names neither leaves the
    // account's own name to stand for both, which is what a household would
    // write if they were typing it in.
    const institution = text(a.org?.name, 100) || name;
    const type = guessAccountType(`${name} ${institution}`, balance);

    accounts.push({
      syncId,
      name,
      institution,
      balance,
      currency: text(a.currency, 10) || "USD",
      type,
      balanceDate: dayOf(a["balance-date"]) ?? fetchedAt.slice(0, 10),
      domain: domainOf(a.org),
      itemId: SIMPLEFIN_ID,
    });

    for (const t of a.transactions ?? []) {
      const id = text(t.id, 120);
      const amount = toCents(t.amount);
      // Posted is required by the protocol; transacted_at is the day it
      // actually happened where a bridge bothers to say. The posted day is
      // used, because that is the day the money moved on the statement.
      const date = dayOf(t.posted) ?? dayOf(t.transacted_at);
      if (!id || amount === null || !date) continue;
      transactions.push({
        syncId: id,
        accountSyncId: syncId,
        date,
        amount,
        description: text(t.description, 200),
        payee: text(t.payee, 100) || undefined,
        memo: text(t.memo, 200) || undefined,
        pending: t.pending === true,
      });
    }
  }

  return {
    accounts,
    transactions,
    errors: (raw.errors ?? []).map((e) => text(e, 300)).filter(Boolean),
    fetchedAt,
  };
}

/** One pull, over a window. */
export async function fetchBridge(
  ref: Pick<SimplefinRef, "accessUrl">,
  from: ISODate,
  to: ISODate,
): Promise<SyncPayload> {
  const raw = await postJSON<{ accounts: RawAccount[]; errors: string[] }>(PROXY, {
    accessUrl: ref.accessUrl, from, to,
  });
  return toPayload(raw, new Date().toISOString());
}
