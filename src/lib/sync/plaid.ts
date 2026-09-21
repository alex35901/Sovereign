import type { AssetClass, PlaidItemRef } from "../../types.js";
import type { RemoteAccount, RemoteTransaction, SyncPayload } from "./types.js";
import { postJSON } from "../api.js";
import { FIRST_PULL_DAYS, cleanMerchant } from "./merge.js";
import type { ItemReach } from "./history.js";
import { today } from "../date.js";

/**
 * Plaid. The Trial plan is free for up to 10 institutions and, unlike SimpleFIN,
 * returns holdings for investment and retirement accounts.
 */
const PROXY = "/api/plaid";

export type PlaidItem = PlaidItemRef;

/* ── Plaid's response shapes, narrowed to what is used ─────────────────── */

interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances: { current?: number | null; available?: number | null; iso_currency_code?: string | null };
}
interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  merchant_name?: string | null;
  pending?: boolean;
  /** The pending transaction this one settles, which carries a different id. */
  pending_transaction_id?: string | null;
}
interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity: number;
  cost_basis?: number | null;
  institution_price?: number | null;
  institution_value?: number | null;
}
interface PlaidSecurity {
  security_id: string;
  ticker_symbol?: string | null;
  name?: string | null;
  type?: string | null;
  close_price?: number | null;
}

export interface SyncResponse {
  accounts: PlaidAccount[];
  transactions: PlaidTransaction[];
  holdings: PlaidHolding[];
  securities: PlaidSecurity[];
  /** How many Plaid says are in the window, whether or not they all came. */
  total?: number;
  /** Set when the window could not be read to the end of. */
  truncated?: boolean;
}

/* ── mapping ──────────────────────────────────────────────────────────── */

const cents = (v: number | null | undefined): number => Math.round((v ?? 0) * 100);

/** Plaid's type/subtype pair maps cleanly onto this app's account types. */
export function mapAccountType(type: string, subtype?: string | null): RemoteAccount["type"] {
  const s = (subtype ?? "").toLowerCase();
  if (type === "credit") return "credit";
  if (type === "loan") return s === "mortgage" ? "mortgage" : "loan";
  if (type === "depository") return s === "savings" || s === "money market" || s === "cd" ? "savings" : "checking";
  if (type === "investment") {
    if (/401k|403b|457b|pension|roth|ira|sep|simple|thrift|keogh|profit sharing/.test(s)) return "retirement";
    if (s === "crypto exchange") return "crypto";
    return "investment";
  }
  return "other_asset";
}

/** Liabilities come back positive from Plaid and are stored negative here. */
export const isLiability = (type: string): boolean => type === "credit" || type === "loan";

export function mapAssetClass(securityType?: string | null): AssetClass {
  switch ((securityType ?? "").toLowerCase()) {
    case "equity":
    case "etf":
    case "mutual fund":
      return "us_equity";
    case "fixed income":
      return "bond";
    case "cash":
      return "cash";
    case "cryptocurrency":
      return "crypto";
    default:
      return "other";
  }
}

export interface PlaidDiagnosis {
  environment: "sandbox" | "production";
  envVarSet: boolean;
  clientId: { length: number; trimmed: boolean };
  secret: { length: number; trimmed: boolean };
  probe: { ok: boolean; error: string | null };
  /** Which environment these credentials are actually valid for, if any. */
  worksIn: "sandbox" | "production" | null;
}

/** Asks the function what it sees, without any credential leaving the server. */
export const diagnosePlaid = (): Promise<PlaidDiagnosis> => postJSON<PlaidDiagnosis>(PROXY, { action: "diagnose" });

export async function createLinkToken(kind: "bank" | "investment"): Promise<string> {
  const products = kind === "investment" ? ["investments"] : ["transactions"];
  const { linkToken } = await postJSON<{ linkToken: string }>(PROXY, {
    action: "link_token", products,
    // How far back Plaid fetches is settled when the item is created, not when
    // it is read. Left unsaid it is ninety days, and no later request can widen
    // it: /transactions/get returns what Plaid holds, and a two-year window
    // over ninety days of history looks exactly like a bank with no past.
    ...(kind === "bank" ? { historyDays: FIRST_PULL_DAYS } : {}),
  });
  return linkToken;
}

/**
 * A link token that reopens an item already connected, for the login a bank
 * has decided to stop accepting.
 *
 * The access token is unchanged by this: that is what makes it worth doing.
 * Removing the item and adding it again would work too, and would mint a new
 * token, which on an encrypted document means editing an environment variable
 * in Vercel and redeploying before the overnight pull can see the bank again.
 */
export async function reconnectLinkToken(
  accessToken: string,
  opts: { consentTo?: string[]; historyDays?: number } = {},
): Promise<{ linkToken: string; dropped: string[] }> {
  const res = await postJSON<{ linkToken: string; dropped?: string[] }>(PROXY, {
    action: "link_token", accessToken,
    // Asked for only when something is actually missing. Requesting consent
    // that was already given is noise in the dialog the person has to read.
    ...(opts.consentTo?.length ? { consentTo: opts.consentTo } : {}),
    // Update mode is the only place an item that already exists can be told to
    // go further back than it was created with.
    ...(opts.historyDays ? { historyDays: opts.historyDays } : {}),
  });
  return { linkToken: res.linkToken, dropped: res.dropped ?? [] };
}

export async function exchangePublicToken(publicToken: string, kind: "bank" | "investment"): Promise<PlaidItem> {
  const res = await postJSON<{
    accessToken: string; itemId: string; institution: string; logo?: string; domain?: string;
  }>(PROXY, { action: "exchange", publicToken });
  return { ...res, kind, addedAt: new Date().toISOString() };
}

/**
 * The institution behind an access token, asked for again.
 *
 * An item connected before the app kept logos has none, and nothing in a sync
 * would ever fill that in: the logo rides along on the item, so an item without
 * one hands `undefined` to every account on every pull, for ever.
 */
export const fetchInstitution = (accessToken: string): Promise<InstitutionMark> =>
  postJSON<InstitutionMark>(PROXY, { action: "institution", accessToken });

export interface InstitutionMark { institution: string; logo?: string; domain?: string }

/** Long enough that a bank Plaid holds no logo for isn't asked again every sync. */
const RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether an item is still missing its mark and is due another ask. */
export function needsInstitution(
  item: { logo?: string; domain?: string; institutionCheckedAt?: string },
  now: number = Date.now(),
): boolean {
  if (item.logo || item.domain) return false;
  if (!item.institutionCheckedAt) return true;
  const at = Date.parse(item.institutionCheckedAt);
  return !Number.isFinite(at) || now - at > RECHECK_MS;
}

export interface RemoteHolding {
  /** the Plaid account this position sits in */
  accountSyncId: string;
  ticker: string;
  name: string;
  quantity: number;
  /** per share, cents */
  costBasis: number;
  /** per share, cents */
  price: number;
  assetClass: AssetClass;
  /** What the provider calls it: "etf", "mutual fund", "equity", "cash". */
  securityType?: string;
}

export interface PlaidPayload extends SyncPayload {
  holdings: RemoteHolding[];
}

/**
 * How many transactions Plaid holds in a window, without fetching any of them.
 *
 * What the Full history wait watches: the figure climbs while Plaid fills in
 * the older months and stops when it has finished. See lib/sync/history.
 */
export async function countHistory(item: { accessToken: string }, since: string): Promise<number> {
  const { total } = await postJSON<{ total: number; notReady: boolean }>(PROXY, {
    action: "count", accessToken: item.accessToken, startDate: since, endDate: today(),
  });
  return total;
}

/**
 * Hands an access token back to Plaid, so a connection no longer used stops
 * counting against the plan's ceiling of ten. False when Plaid would not,
 * which is never worth blocking anything over.
 */
export const releaseItem = (item: { accessToken: string }): Promise<boolean> =>
  postJSON<{ removed: boolean }>(PROXY, { action: "remove", accessToken: item.accessToken })
    .then((r) => r.removed)
    .catch(() => false);

/**
 * Asks Plaid to go and fetch this item's transactions now, rather than on its
 * own schedule. False when Plaid would not, which costs nothing but time.
 */
export const refreshItem = (item: { accessToken: string }): Promise<boolean> =>
  postJSON<{ asked: boolean }>(PROXY, { action: "refresh", accessToken: item.accessToken })
    .then((r) => r.asked)
    .catch(() => false);

/**
 * What Plaid holds for this item, rather than what it will hand over now.
 *
 * The one question the app could not answer while Full history was stalling:
 * whether a short window meant a backfill still running or a bank that gives
 * ninety days and no more. See lib/sync/history describeReach.
 */
export const reportHistory = (item: { accessToken: string }, since: string): Promise<ItemReach> =>
  postJSON<ItemReach>(PROXY, { action: "report", accessToken: item.accessToken, startDate: since, endDate: today() });

export async function fetchItem(item: PlaidItem, since: string): Promise<PlaidPayload> {
  const raw = await postJSON<SyncResponse>(PROXY, {
    action: "sync",
    accessToken: item.accessToken,
    startDate: since,
    endDate: today(),
    withHoldings: item.kind === "investment",
    // An investment item consented to investments. Asking it for transactions
    // is refused, correctly, and the refusal is not worth reporting because
    // nobody asked for them.
    withTransactions: item.kind !== "investment",
  });
  return toPlaidPayload(raw, item);
}

/** What an item contributes to every account it owns: its name and its mark. */
export interface ItemMark { institution: string; logo?: string; domain?: string }

/**
 * Plaid's shapes, turned into this app's.
 *
 * Pure, and separate from the fetch above, because the scheduled sync pulls the
 * same response from inside a serverless function rather than through the
 * browser proxy — and two copies of this mapping would be two sign conventions
 * waiting to disagree.
 */
export function toPlaidPayload(raw: SyncResponse, item: ItemMark): PlaidPayload {
  // The day the balance belongs to is the day where the person is. SimpleFIN
  // already dates its readings this way; this used to use UTC, so a sync run
  // in the evening in California wrote a reading dated tomorrow, which the
  // charts would not show until tomorrow came.
  const stamped = today();
  const accounts: RemoteAccount[] = (raw.accounts ?? []).map((a) => {
    const magnitude = cents(a.balances.current);
    return {
      syncId: a.account_id,
      name: a.official_name || a.name,
      institution: item.institution,
      balance: isLiability(a.type) ? -Math.abs(magnitude) : magnitude,
      currency: a.balances.iso_currency_code ?? "USD",
      type: mapAccountType(a.type, a.subtype),
      balanceDate: stamped,
      // Carried from the item, which fetched it once when it was connected.
      logo: item.logo,
      domain: item.domain,
    };
  });

  const transactions: RemoteTransaction[] = (raw.transactions ?? []).map((t) => ({
    syncId: t.transaction_id,
    accountSyncId: t.account_id,
    date: t.date,
    // Plaid reports money leaving an account as positive; this app uses the
    // opposite sign convention throughout
    amount: -cents(t.amount),
    description: t.name,
    payee: t.merchant_name ? cleanMerchant(t.merchant_name) : undefined,
    pending: Boolean(t.pending),
    replacesSyncId: t.pending_transaction_id ?? undefined,
  }));

  const securities = new Map((raw.securities ?? []).map((s) => [s.security_id, s]));
  const holdings: RemoteHolding[] = (raw.holdings ?? []).map((h) => {
    const security = securities.get(h.security_id);
    const price = cents(h.institution_price ?? security?.close_price);
    const totalCost = cents(h.cost_basis);
    return {
      accountSyncId: h.account_id,
      ticker: security?.ticker_symbol || security?.name?.slice(0, 12) || "-",
      name: security?.name || security?.ticker_symbol || "Unknown holding",
      quantity: h.quantity,
      // Plaid's cost_basis is the total for the position; this app stores it per share
      costBasis: h.quantity ? Math.round(totalCost / h.quantity) : 0,
      price,
      assetClass: mapAssetClass(security?.type),
      // Kept as the provider said it, rather than folded into assetClass:
      // "what it holds" and "what kind of product it is" are two questions,
      // and an index fund and its ETF twin answer them differently.
      securityType: typeof security?.type === "string" ? security.type : undefined,
    };
  });

  return {
    accounts,
    transactions,
    // A window that could not be read to the end of has transactions missing
    // from it, and the one thing worse than that is not saying so.
    errors: raw.truncated
      ? [`Plaid has ${raw.total} transactions in this window and sent ${transactions.length}. `
        + "Sync a shorter period, or sync again to pick up the rest."]
      : [],
    fetchedAt: new Date().toISOString(),
    holdings,
  };
}
