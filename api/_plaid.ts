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

export async function fetchItemRaw(creds: PlaidCreds, opts: {
  accessToken: string;
  startDate: string;
  endDate: string;
  withHoldings?: boolean;
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
    for (;;) {
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
    if (!(err instanceof PlaidError) || !NO_TRANSACTIONS_CODES.has(err.code)) throw err;
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
