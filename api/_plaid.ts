/**
 * Plaid's upstream, reachable from any function here.
 *
 * Split out of api/plaid.ts when the scheduled sync needed the same pull: the
 * browser's path goes through that proxy, but the cron job has no browser and a
 * relative URL would not resolve from inside a serverless function anyway. One
 * copy of the paging, the timeout and the error shapes, so the overnight pull
 * and the hands-on one cannot disagree about what Plaid said.
 *
 * Credentials never leave this file's callers: client_id and secret authorise
 * every request for every item, so they stay in environment variables and are
 * read here rather than passed around.
 */

const UPSTREAM_TIMEOUT_MS = 25_000;

/** Plaid's own maximum for one page of /transactions/get. */
export const PAGE_SIZE = 500;

/**
 * Ten thousand transactions in one window, which is years of a busy account.
 * A ceiling rather than a limit: it exists so a provider that keeps saying
 * "there are more" cannot hold a function open until it is killed.
 */
export const MAX_PAGES = 20;

export type PlaidEnv = "sandbox" | "production";

export const plaidEnv = (): PlaidEnv => (process.env.PLAID_ENV === "sandbox" ? "sandbox" : "production");

export class PlaidError extends Error {
  constructor(public status: number, message: string, public code = "") {
    super(message);
    this.name = "PlaidError";
  }
}

export interface PlaidCreds {
  clientId: string;
  secret: string;
  /** Before trimming, so the diagnose action can report a stray space. */
  rawClientId: string;
  rawSecret: string;
}

/** The credentials, or null when the deployment has not been given any. */
export function plaidCreds(): PlaidCreds | null {
  const rawClientId = process.env.PLAID_CLIENT_ID ?? "";
  const rawSecret = process.env.PLAID_SECRET ?? "";
  const clientId = rawClientId.trim();
  const secret = rawSecret.trim();
  if (!clientId || !secret) return null;
  return { clientId, secret, rawClientId, rawSecret };
}

const CHECK_POINTER = " Press “Check configuration” below to see which one Plaid is refusing.";

/** Plaid's error bodies are structured; turn them into one readable line. */
export function describe(body: Record<string, unknown>): string {
  const code = typeof body.error_code === "string" ? body.error_code : "";
  const message = typeof body.error_message === "string" ? body.error_message : "Plaid rejected the request.";
  if (code === "INVALID_API_KEYS") {
    return "Plaid rejected the credentials. The usual cause is a secret from the wrong environment: Plaid issues a separate secret for Sandbox and for Production, and this app talks to Production unless PLAID_ENV says otherwise." + CHECK_POINTER;
  }
  if (code === "ITEM_LOGIN_REQUIRED") return "This connection needs re-authenticating at the bank. Reconnect it below.";
  if (code === "PRODUCTS_NOT_SUPPORTED") return "That institution doesn't offer this data through Plaid. Try connecting it as the other account type.";
  if (code === "NO_INVESTMENT_ACCOUNTS") return "Plaid found no investment accounts on that login.";
  if (code === "RATE_LIMIT_EXCEEDED") return "Plaid is rate-limiting this request. Wait a minute and try again.";
  if (code === "ADDITIONAL_CONSENT_REQUIRED") {
    return "This connection was set up without permission to read its transactions. Reconnect it below and "
      + "tick transactions when the bank asks, or leave it as an investment connection if that is all it is for.";
  }
  if (code === PRODUCT_NOT_READY) {
    return "Plaid is still preparing this connection's transactions. It pulls the history in the background "
      + "after a bank is linked, which usually takes a minute or two. Press Sync again shortly.";
  }
  return code ? `${message} (${code})` : message;
}

/**
 * Plaid has the item, and not the transactions yet.
 *
 * A bank linked a moment ago answers /accounts/get immediately and
 * /transactions/get with this, because the history is pulled in the background
 * after the link. Balances arrive, transactions do not, and nothing about it
 * is wrong except the timing.
 */
export const PRODUCT_NOT_READY = "PRODUCT_NOT_READY";

/** How long to give a brand new item to finish preparing, in total. */
export const READY_WAIT_MS = 12_000;
/** How long to leave it between asks while waiting. */
const READY_GAP_MS = 4_000;

/**
 * The codes that genuinely mean "there are no transactions to be had here",
 * as opposed to "not yet" or "not until you sign in again".
 *
 * Kept as a list of what is known rather than as "any refusal", because the
 * previous rule was that every 400 meant an item without the transactions
 * product, and a brand new bank connection returns exactly that. Balances
 * appeared, no transaction ever did, and nothing was reported.
 */
export const NO_TRANSACTIONS_CODES = new Set([
  "PRODUCTS_NOT_SUPPORTED",
  "NO_ACCOUNTS",
]);

/**
 * The item never agreed to hand over transactions.
 *
 * Fixable, by reconnecting and consenting, so it is reported rather than
 * swallowed wherever the caller knows what the item is meant to be for. The
 * scheduled job does not: it works from bare access tokens, and an
 * investment item refusing to discuss transactions there is the expected
 * answer rather than news.
 */
export const NEEDS_CONSENT = "ADDITIONAL_CONSENT_REQUIRED";

/**
 * How far back a bank is asked to go when it is linked.
 *
 * Plaid fetches 90 days when an item is created unless the link token says
 * otherwise, and /transactions/get can only ever return what Plaid already
 * holds. So a start date two years back is not enough on its own: an item
 * created without this answers a two-year request with ninety days and no
 * error, which reads exactly like a bank that has no older history. 730 is
 * Plaid's maximum.
 */
export const HISTORY_DAYS = 730;

/**
 * The refusals that mean "I do not accept that field", as opposed to anything
 * about the item or the credentials.
 */
const REFUSED_FIELD = new Set(["INVALID_FIELD", "INVALID_BODY", "UNKNOWN_FIELDS"]);

/**
 * A link token, with the optional parts dropped one at a time if Plaid will
 * not take them.
 *
 * Two of the fields sent here steer the dialog rather than define it:
 * additional_consented_products, which repairs an item linked without
 * permission to read transactions, and transactions.days_requested, which
 * sets how far back the history goes. Neither is worth failing over. A
 * reconnect that opens is a bank a household can get back; a reconnect that
 * errors because Plaid renamed a field is a dead end in the one screen that
 * exists to escape dead ends.
 *
 * Least important first from the end: the ordering decides what is given up
 * first, and permission to read transactions at all outranks how far back
 * they go.
 */
export async function linkTokenCreate(
  creds: PlaidCreds,
  base: Record<string, unknown>,
  optional: readonly (readonly [string, unknown])[],
): Promise<{ data: Record<string, unknown>; dropped: string[] }> {
  const dropped: string[] = [];
  for (let keep = optional.length; ; keep--) {
    const extra = Object.fromEntries(optional.slice(0, keep));
    try {
      return { data: await plaidCall(creds, "/link/token/create", { ...base, ...extra }), dropped };
    } catch (err) {
      if (keep === 0 || !(err instanceof PlaidError) || !REFUSED_FIELD.has(err.code)) throw err;
      dropped.unshift(optional[keep - 1]![0]);
    }
  }
}

export async function plaidCall(
  creds: PlaidCreds,
  path: string,
  payload: Record<string, unknown>,
  on: PlaidEnv = plaidEnv(),
): Promise<Record<string, unknown>> {
  const upstream = await fetch(`https://${on}.plaid.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: creds.clientId, secret: creds.secret, ...payload }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const text = await upstream.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new PlaidError(502, `Plaid returned something that wasn't JSON (${upstream.status}).`);
  }
  if (!upstream.ok) {
    throw new PlaidError(upstream.status, describe(parsed), typeof parsed.error_code === "string" ? parsed.error_code : "");
  }
  return parsed;
}

/** One item's accounts, transactions and — when asked for — holdings. */
export interface PlaidRaw {
  accounts: unknown[];
  transactions: unknown[];
  holdings: unknown[];
  securities: unknown[];
  /** How many Plaid says are in the window, whether or not they all came. */
  total: number;
  /** Set when the window could not be read to the end of. */
  truncated: boolean;
}

/**
 * How many transactions Plaid holds in a window, and nothing else.
 *
 * One upstream call asking for a single row, because the answer wanted is
 * total_transactions rather than any of the transactions. Plaid fills an
 * item's older history in the background after the reach is raised, and this
 * is the signal that it has: the figure climbs while the backfill runs and
 * stops when it is done. Polling the real pull for that would page through
 * thousands of rows every few seconds to read one number off the top.
 *
 * "Not ready" is an answer rather than a failure here. A brand new item says
 * it, and the caller is a loop whose whole job is to wait.
 */
export async function countTransactions(creds: PlaidCreds, opts: {
  accessToken: string;
  startDate: string;
  endDate: string;
}): Promise<{ total: number; notReady: boolean }> {
  try {
    const got = await plaidCall(creds, "/transactions/get", {
      access_token: opts.accessToken,
      start_date: opts.startDate,
      end_date: opts.endDate,
      options: { count: 1, offset: 0 },
    }) as { total_transactions?: number };
    return { total: typeof got.total_transactions === "number" ? got.total_transactions : 0, notReady: false };
  } catch (err) {
    if (err instanceof PlaidError && err.code === PRODUCT_NOT_READY) return { total: 0, notReady: true };
    throw err;
  }
}

/**
 * Asks Plaid to go and fetch this item's transactions now.
 *
 * Raising an item's reach through update mode says what is wanted; it does not
 * say when. Plaid refreshes an item on its own cycle, and a household watching
 * a count that has not moved has no way to tell "the longer window was not
 * applied" from "it was, and nothing has run since". This is the nudge, and it
 * is the difference between a wait that means something and a spinner.
 *
 * Never fatal. It is an optimisation on top of waiting, not a requirement, and
 * a plan that does not include it should cost nothing more than the wait it
 * would have shortened.
 */
export async function refreshTransactions(creds: PlaidCreds, accessToken: string): Promise<boolean> {
  try {
    await plaidCall(creds, "/transactions/refresh", { access_token: accessToken });
    return true;
  } catch {
    return false;
  }
}

/** What Plaid actually holds for an item, in its own words. */
export interface ItemReport {
  /** How many transactions Plaid has in the window asked about. */
  total: number;
  notReady: boolean;
  /** The oldest and newest days Plaid holds, or undefined when it holds none. */
  oldest?: string;
  newest?: string;
  /** What the item agreed to, was created for, and is billed for. */
  consented: string[];
  products: string[];
  billed: string[];
  /** When Plaid last successfully refreshed this item's transactions. */
  lastUpdate?: string;
  institutionId?: string;
}

/**
 * The honest answer to "how far back does this connection actually go".
 *
 * Raising an item's reach is a request, not a guarantee: Plaid applies it when
 * the institution can serve it, and plenty of banks hand over ninety days and
 * nothing more whatever is asked for. Without this the two cases look
 * identical from the outside - a window that came back short reads as a
 * backfill still running, for ever - and the app kept saying "still fetching"
 * about a bank that had already sent everything it had.
 *
 * Three calls: the count, the far end of it, and what Plaid says about the
 * item. The far end is read by asking for one row at each end of the window
 * and taking the earlier and later of the two days, rather than by trusting
 * which way round Plaid sorts a page.
 */
export async function reportItem(creds: PlaidCreds, opts: {
  accessToken: string;
  startDate: string;
  endDate: string;
}): Promise<ItemReport> {
  const { total, notReady } = await countTransactions(creds, opts);

  const dayAt = async (offset: number): Promise<string | undefined> => {
    const got = await plaidCall(creds, "/transactions/get", {
      access_token: opts.accessToken,
      start_date: opts.startDate,
      end_date: opts.endDate,
      options: { count: 1, offset },
    }).catch(() => null) as { transactions?: { date?: string }[] } | null;
    const day = got?.transactions?.[0]?.date;
    return typeof day === "string" ? day : undefined;
  };

  // One row from each end. Asking for the same row twice when there is only
  // one is a wasted call, so it is not made.
  const ends = total > 0
    ? await Promise.all([dayAt(0), total > 1 ? dayAt(total - 1) : Promise.resolve(undefined)])
    : [];
  const days = ends.filter((d): d is string => typeof d === "string").sort();

  const got = await plaidCall(creds, "/item/get", { access_token: opts.accessToken }).catch(() => null);
  const item = (got?.item ?? {}) as {
    consented_products?: unknown; products?: unknown; billed_products?: unknown;
    institution_id?: unknown;
    status?: { transactions?: { last_successful_update?: unknown } };
  };
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const last = item.status?.transactions?.last_successful_update;

  return {
    total,
    notReady,
    oldest: days[0],
    newest: days[days.length - 1],
    consented: list(item.consented_products),
    products: list(item.products),
    billed: list(item.billed_products),
    lastUpdate: typeof last === "string" ? last : undefined,
    institutionId: typeof item.institution_id === "string" ? item.institution_id : undefined,
  };
}

export async function fetchItemRaw(creds: PlaidCreds, opts: {
  accessToken: string;
  startDate: string;
  endDate: string;
  withHoldings?: boolean;
  /**
   * Whether to ask for transactions at all.
   *
   * An item connected for investments consented to investments, and asking it
   * for transactions is refused with ADDITIONAL_CONSENT_REQUIRED, which is
   * Plaid being correct rather than anything being broken. The caller that
   * knows what the item is for says so; the scheduled job works from bare
   * tokens and cannot know, so it asks and takes the refusal quietly.
   */
  withTransactions?: boolean;
  /**
   * How long to give a brand new item to finish preparing. Defaults to the
   * budget below; a test that wants to see the refusal rather than wait for
   * it passes zero.
   */
  readyWaitMs?: number;
}): Promise<PlaidRaw> {
  const accounts = await plaidCall(creds, "/accounts/get", { access_token: opts.accessToken });

  // Paged, because /transactions/get is paginated and one page is not the
  // answer. It returns at most 500 at a time, newest first, and says in
  // total_transactions how many there really are — so asking once for 500
  // and stopping silently discarded everything older than the newest 500 in
  // the window. A busy account loses whole weeks that way and says nothing.
  const once = (offset: number) => plaidCall(creds, "/transactions/get", {
    access_token: opts.accessToken,
    start_date: opts.startDate,
    end_date: opts.endDate,
    options: { count: PAGE_SIZE, offset },
  });

  /**
   * The same call, giving a brand new item a moment to be ready.
   *
   * Plaid fetches an item's history in the background after it is linked, so
   * the first ask often lands before there is anything to answer with. Waiting
   * a few seconds turns "connected, and no transactions ever appeared" into
   * "connected, and they were there" for most banks. When it is not enough the
   * error says so in words, and says to press Sync again, which is the whole
   * of what anyone needs to do about it.
   *
   * Only the first page waits: later pages are being served from data that by
   * definition already exists.
   */
  const page = async (offset: number): Promise<unknown> => {
    const budget = opts.readyWaitMs ?? READY_WAIT_MS;
    const until = Date.now() + (offset === 0 ? budget : 0);
    for (;;) {
      try {
        return await once(offset);
      } catch (err) {
        const notReady = err instanceof PlaidError && err.code === PRODUCT_NOT_READY;
        const left = until - Date.now();
        if (!notReady || left <= 0) throw err;
        // Never longer than what is left, or a budget shorter than the gap
        // would spend none of itself and give up on the first refusal.
        await new Promise((r) => setTimeout(r, Math.min(READY_GAP_MS, left)));
      }
    }
  };

  let rows: unknown[] = [];
  let total = 0;
  let pages = 0;
  try {
    // Asked for unless the caller knows this item does not carry them.
    for (; opts.withTransactions !== false;) {
      const got = await page(rows.length) as { transactions?: unknown[]; total_transactions?: number };
      const batch = got.transactions ?? [];
      total = typeof got.total_transactions === "number" ? got.total_transactions : rows.length + batch.length;
      rows = rows.concat(batch);
      pages += 1;
      // A page that comes back short or empty is the end of it, whatever
      // the total claims — without that this loops on a provider that
      // disagrees with itself.
      if (batch.length < PAGE_SIZE || rows.length >= total || pages >= MAX_PAGES) break;
    }
  } catch (err: unknown) {
    // An item that carries no transactions product has none to give, and that
    // is not a failure. Anything else is, and used to be swallowed: every 400
    // was read as "investment-only item", including the one a bank linked a
    // moment ago returns while Plaid is still fetching its history, and the
    // one a bank returns when it wants a new login. Both produced an account
    // with balances, no transactions, and no explanation anywhere.
    //
    // Consent is the one that depends on who is asking. A caller that said
    // this item is for transactions wants to hear that it cannot have them,
    // because that is fixable by reconnecting. A caller that did not say,
    // which is the scheduled job working from a bare access token, is asking
    // on the off chance and an investment item's refusal is the expected
    // answer rather than news.
    const known = err instanceof PlaidError && NO_TRANSACTIONS_CODES.has(err.code);
    const consent = err instanceof PlaidError
      && err.code === NEEDS_CONSENT
      && opts.withTransactions === undefined;
    if (!known && !consent) throw err;
    rows = [];
    total = 0;
  }

  let holdings: Record<string, unknown> = { holdings: [], securities: [] };
  if (opts.withHoldings) {
    holdings = await plaidCall(creds, "/investments/holdings/get", { access_token: opts.accessToken })
      .catch(() => ({ holdings: [], securities: [] }));
  }

  return {
    accounts: (accounts.accounts as unknown[]) ?? [],
    transactions: rows,
    total,
    truncated: rows.length < total,
    holdings: (holdings.holdings as unknown[]) ?? [],
    securities: (holdings.securities as unknown[]) ?? [],
  };
}

export interface ItemIdentity { institution: string; logo?: string; domain?: string }

/**
 * Who an access token belongs to, and their mark. Neither endpoint is billed
 * per call, so this is safe to ask again for an item connected before the app
 * knew to keep the answer — and for the scheduled run, which is handed a bare
 * token and has nothing else to call the bank.
 */
export async function identifyItem(creds: PlaidCreds, accessToken: string): Promise<ItemIdentity> {
  const item = await plaidCall(creds, "/item/get", { access_token: accessToken }).catch(() => null);
  const institutionId = (item?.item as { institution_id?: string } | undefined)?.institution_id;
  let institution = "Connected account";
  let logo: string | undefined;
  let domain: string | undefined;
  if (institutionId) {
    const inst = await plaidCall(creds, "/institutions/get_by_id", {
      institution_id: institutionId,
      country_codes: ["US"],
      // Plaid withholds the logo, colour and website unless asked.
      options: { include_optional_metadata: true },
    }).catch(() => null);
    const found = inst?.institution as { name?: string; logo?: string; url?: string } | undefined;
    institution = found?.name ?? institution;
    // Base64 PNG straight from Plaid, so no third party ever sees which
    // institutions these are.
    if (found?.logo) logo = `data:image/png;base64,${found.logo}`;
    if (found?.url) domain = hostOf(found.url);
  }
  return { institution, logo, domain };
}

/** "https://www.chase.com/" → "chase.com" */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
