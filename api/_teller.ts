import type { RemoteAccount, RemoteTransaction, SyncPayload } from "../src/lib/sync/types.js";

/**
 * Teller's upstream, reachable from any function here.
 *
 * Here for the same reason _plaid.ts is: the browser's path goes through a
 * proxy and the scheduled job has no browser, and both must agree about what
 * the bank said. And for one reason Plaid does not have. Teller authenticates
 * the *application* with a client certificate rather than a header, so every
 * call needs a private key, and a private key is the one thing that can never
 * be anywhere near a browser.
 *
 * Why there is a second provider at all: Plaid will not connect the big banks
 * until the Plaid account asking has been separately approved for each of
 * them, and a household that cannot get that approval has no way through at
 * any price. Teller has no such gate. So this is not a replacement for Plaid,
 * it is the way round one bank that Plaid will not open.
 */

const UPSTREAM_TIMEOUT_MS = 25_000;

/** Rows per page. Teller returns newest first and pages backwards by id. */
const PAGE_SIZE = 200;

/**
 * Pages in one pull. A ceiling rather than a limit: it exists so a provider
 * that keeps saying "there are more" cannot hold a function open until it is
 * killed.
 */
const MAX_PAGES = 25;

export type TellerEnv = "sandbox" | "development" | "production";

export const tellerEnv = (): TellerEnv => {
  const said = (process.env.TELLER_ENV ?? "").trim().toLowerCase();
  return said === "sandbox" || said === "development" ? said : "production";
};

export class TellerError extends Error {
  constructor(public status: number, message: string, public code = "") {
    super(message);
    this.name = "TellerError";
  }
}

export interface TellerCreds {
  /** The application id, which is not a secret: Connect needs it in the page. */
  appId: string;
  cert: string;
  key: string;
  /** Before repair, so the diagnose action can say what shape they arrived in. */
  rawCert: string;
  rawKey: string;
}

/**
 * A PEM that has been through an environment variable.
 *
 * A certificate is several lines and an environment variable is one, so the
 * newlines arrive as the two characters backslash-n about as often as they
 * arrive as newlines. Both are accepted, because the alternative is a
 * deployment that fails with "error:0909006C" and no clue which of the two
 * happened. Surrounding quotes go too: a value pasted with them is a value
 * with them.
 */
export function readPem(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  // A PEM ending without its newline is rejected by OpenSSL on some versions,
  // and nothing is lost by always having one.
  return s ? `${s}\n` : "";
}

/** Whether this looks like a PEM block at all, and which kind. */
export const pemKind = (pem: string): string | null =>
  pem.match(/-----BEGIN ([A-Z ]+)-----/)?.[1] ?? null;

/** The credentials, or null when the deployment has not been given any. */
export function tellerCreds(): TellerCreds | null {
  const appId = (process.env.TELLER_APP_ID ?? "").trim();
  const rawCert = process.env.TELLER_CERT ?? "";
  const rawKey = process.env.TELLER_KEY ?? "";
  const cert = readPem(rawCert);
  const key = readPem(rawKey);
  if (!appId || !cert || !key) return null;
  return { appId, cert, key, rawCert, rawKey };
}

/**
 * One call to Teller, over a connection the certificate authenticates.
 *
 * node:https rather than fetch, because the certificate is a property of the
 * connection rather than of the request and fetch has no way to say so without
 * reaching into undici. A core module also means nothing to install, which
 * matters here: every bare import in this directory has to be lazy or the
 * function fails to load at all.
 */
export async function tellerCall(
  creds: TellerCreds,
  path: string,
  accessToken: string,
): Promise<unknown> {
  const https = await import("node:https");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "api.teller.io",
        path,
        method: "GET",
        cert: creds.cert,
        key: creds.key,
        headers: {
          // Teller takes the access token as the basic-auth username, with no
          // password, which is why the colon is not a typo.
          authorization: `Basic ${Buffer.from(`${accessToken}:`).toString("base64")}`,
          accept: "application/json",
        },
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            reject(new TellerError(502, `Teller returned something that wasn't JSON (${status}).`));
            return;
          }
          if (status < 200 || status >= 300) {
            reject(new TellerError(status, describe(parsed, status), codeOf(parsed)));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new TellerError(504, "Teller did not answer in time."));
    });
    req.on("error", (err: Error & { code?: string }) => {
      reject(certTrouble(err) ?? new TellerError(502, `Could not reach Teller. ${err.message}`));
    });
    req.end();
  });
}

/**
 * The failures that are about the certificate rather than about the bank.
 *
 * Worth separating, because they are the ones a household can actually fix and
 * the ones whose raw text is least like a sentence. "error:0480006C" is the
 * private key not being a private key.
 */
function certTrouble(err: Error & { code?: string }): TellerError | null {
  const text = `${err.code ?? ""} ${err.message}`;
  if (/ERR_SSL|PEM|DECODER|no start line|bad decrypt|key values mismatch/i.test(text)) {
    return new TellerError(
      500,
      "Teller refused the certificate. Check that TELLER_CERT holds the certificate and TELLER_KEY the "
      + "private key, each complete with its BEGIN and END lines, and that they are the pair downloaded "
      + "together.",
      "BAD_CERTIFICATE",
    );
  }
  if (/UNABLE_TO_VERIFY|SELF_SIGNED|CERT_HAS_EXPIRED|ALERT_CERTIFICATE|SSLV3_ALERT|HANDSHAKE/i.test(text)) {
    return new TellerError(
      502,
      "Teller rejected the certificate during the handshake. The usual cause is a certificate from a "
      + "different Teller application, or one that has been revoked.",
      "CERTIFICATE_REJECTED",
    );
  }
  return null;
}

const codeOf = (body: unknown): string => {
  const error = (body as { error?: { code?: unknown } })?.error;
  return typeof error?.code === "string" ? error.code : "";
};

/** Teller's error bodies are structured; turn them into one readable line. */
export function describe(body: unknown, status: number): string {
  const error = (body as { error?: { code?: unknown; message?: unknown } })?.error;
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";
  if (code === "enrollment.disconnected" || code === "enrollment.disconnected.credentials_invalid") {
    return "This bank needs signing into again. Reconnect it below and Teller will ask for the login.";
  }
  if (code === "enrollment.disconnected.user_action.mfa_required") {
    return "The bank is asking for a security code. Reconnect it below to answer it.";
  }
  if (code === "enrollment.disconnected.account_locked") {
    return "The bank has locked this login. Sign in on the bank's own site to unlock it, then reconnect here.";
  }
  if (status === 401) {
    return message || "Teller refused this connection's token. Reconnect the bank below.";
  }
  if (status === 429) {
    return "Teller is rate-limiting this request. Wait a minute and try again.";
  }
  return message ? (code ? `${message} (${code})` : message) : `Teller rejected the request (${status}).`;
}

/**
 * A decimal string of dollars, as integer cents.
 *
 * Read off the digits rather than through a float. Teller sends money as a
 * string, and the obvious Math.round(Number(s) * 100) is wrong for values a
 * binary fraction cannot hold: 0.145 becomes 14.499999999999998 and rounds
 * down to fourteen pence. Two decimal places are all a bank sends, so this is
 * belt and braces rather than a live bug, which is the right amount of care
 * for the one function every figure in this provider passes through.
 */
export function toCents(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) : 0;
  if (typeof value !== "string") return 0;
  const s = value.trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) {
    const n = Number(s);
    return Number.isFinite(n) && s !== "" ? Math.round(n * 100) : 0;
  }
  const frac = (m[3] ?? "").padEnd(3, "0");
  const cents = Number(m[2] || "0") * 100 + Number(frac.slice(0, 2));
  // The third digit decides the rounding, with no float anywhere in sight.
  const up = Number(frac[2]) >= 5 ? 1 : 0;
  return (m[1] === "-" ? -1 : 1) * (cents + up);
}

/**
 * Teller's account kinds, in this app's terms.
 *
 * Teller reports two types and a subtype under each. Everything it calls
 * depository that is not a current account is near enough savings, and the one
 * credit subtype it has is a card.
 */
export function mapAccountType(type: unknown, subtype: unknown): RemoteAccount["type"] {
  const t = String(type ?? "").toLowerCase();
  const s = String(subtype ?? "").toLowerCase();
  if (t === "credit") return "credit";
  if (t === "depository") return s === "checking" ? "checking" : "savings";
  return "other_asset";
}

/** Money owed is stored negative here, whichever way the provider signs it. */
export const isLiability = (type: unknown): boolean => String(type ?? "").toLowerCase() === "credit";

interface RawAccount {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  subtype?: unknown;
  currency?: unknown;
  last_four?: unknown;
  enrollment_id?: unknown;
  institution?: { name?: unknown; id?: unknown } | null;
}

/**
 * What to call an account that the bank has named "Checking".
 *
 * Teller gives the product name rather than the account, so a household with
 * two current accounts gets two accounts called Checking and no way to tell
 * them apart. The last four digits are the part that is the account rather
 * than a description of it, so they go on the end when there are any.
 */
export function accountName(raw: RawAccount): string {
  const name = String(raw.name ?? "").trim() || "Account";
  const last = String(raw.last_four ?? "").trim();
  return last ? `${name} ••${last}` : name;
}

export function toRemoteAccount(raw: RawAccount, balanceCents: number, on: string): RemoteAccount {
  const type = mapAccountType(raw.type, raw.subtype);
  return {
    syncId: String(raw.id ?? ""),
    name: accountName(raw),
    institution: String(raw.institution?.name ?? "").trim() || "Bank",
    // Whatever sign Teller puts on a card's balance, what is owed is negative
    // here. Reading it off the type rather than off the figure, because a card
    // that happens to be paid off would otherwise be filed as an asset.
    balance: isLiability(raw.type) ? -Math.abs(balanceCents) : balanceCents,
    currency: String(raw.currency ?? "USD").toUpperCase() || "USD",
    type,
    balanceDate: on,
    itemId: String(raw.enrollment_id ?? "") || undefined,
  };
}

interface RawTransaction {
  id?: unknown;
  account_id?: unknown;
  date?: unknown;
  amount?: unknown;
  description?: unknown;
  status?: unknown;
  details?: { counterparty?: { name?: unknown } | null } | null;
}

/**
 * One transaction, in this app's terms.
 *
 * The sign is taken as Teller gives it: money leaving is negative, on a card
 * as much as on a current account, which is this app's convention too. The
 * counterparty is the bank's own tidying of the statement line and is a better
 * merchant than anything that can be got out of the line itself, so it is
 * offered as the payee and the rules still see the raw line.
 */
export function toRemoteTransaction(raw: RawTransaction): RemoteTransaction {
  const description = String(raw.description ?? "").trim();
  const payee = String(raw.details?.counterparty?.name ?? "").trim();
  return {
    syncId: String(raw.id ?? ""),
    accountSyncId: String(raw.account_id ?? ""),
    date: String(raw.date ?? "").slice(0, 10),
    amount: toCents(raw.amount),
    description: description || payee || "Transaction",
    ...(payee ? { payee } : {}),
    pending: String(raw.status ?? "").toLowerCase() === "pending",
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Every transaction in the window, a page at a time.
 *
 * Teller returns the newest first and pages backwards from an id. Three things
 * stop the loop, because any one of them alone has a way of not happening: a
 * short page, a row older than the window, and a page that hands back the same
 * id as the last one, which is what an API that has quietly ignored the cursor
 * looks like from here.
 */
export type TellerGet = (path: string) => Promise<unknown>;

export async function collectTransactions(
  get: TellerGet,
  accountId: string,
  from: string,
): Promise<RemoteTransaction[]> {
  const out: RemoteTransaction[] = [];
  let cursor: string | null = null;
  let last: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ count: String(PAGE_SIZE) });
    if (cursor) qs.set("from_id", cursor);
    const body = await get(`/accounts/${encodeURIComponent(accountId)}/transactions?${qs}`);
    if (!Array.isArray(body) || body.length === 0) break;
    let oldest = "";
    for (const row of body) {
      if (!isObject(row)) continue;
      const t = toRemoteTransaction(row);
      if (!t.syncId || !t.date) continue;
      // Filtered here as well as asked for, because a window the API did not
      // narrow is a window that has to be narrowed.
      if (t.date >= from) out.push(t);
      if (!oldest || t.date < oldest) oldest = t.date;
    }
    const next = String((body[body.length - 1] as Record<string, unknown>)?.id ?? "");
    if (!next || next === last) break;
    last = next;
    cursor = next;
    if (body.length < PAGE_SIZE) break;
    if (oldest && oldest < from) break;
  }
  return out;
}

/**
 * One enrollment's accounts, balances and transactions.
 *
 * An account that fails on its own is reported and skipped rather than failing
 * the pull: one card refusing should not cost the household the other three
 * accounts behind the same login.
 */
export async function collectEnrollment(
  get: TellerGet,
  from: string,
  opts: { withTransactions?: boolean; now?: () => string } = {},
): Promise<SyncPayload> {
  const fetchedAt = (opts.now ?? (() => new Date().toISOString()))();
  const on = fetchedAt.slice(0, 10);
  const listed = await get("/accounts");
  if (!Array.isArray(listed)) throw new TellerError(502, "Teller did not list any accounts.");

  const accounts: RemoteAccount[] = [];
  const transactions: RemoteTransaction[] = [];
  const errors: string[] = [];

  for (const row of listed) {
    if (!isObject(row)) continue;
    const id = String(row.id ?? "");
    if (!id) continue;
    let cents = 0;
    try {
      const balances = await get(`/accounts/${encodeURIComponent(id)}/balances`);
      // The ledger is what the bank has posted; available takes holds off it,
      // and a balance that moves when a hold lands is a balance that disagrees
      // with the statement every few days.
      const b = isObject(balances) ? balances : {};
      cents = toCents(b.ledger ?? b.available);
    } catch (err) {
      errors.push(`${accountName(row as RawAccount)}: ${err instanceof Error ? err.message : "balance unavailable"}`);
    }
    accounts.push(toRemoteAccount(row as RawAccount, cents, on));

    if (opts.withTransactions === false) continue;
    try {
      transactions.push(...await collectTransactions(get, id, from));
    } catch (err) {
      errors.push(`${accountName(row as RawAccount)}: ${err instanceof Error ? err.message : "transactions unavailable"}`);
    }
  }

  return { accounts, transactions, errors, fetchedAt };
}

/** The two above, over a real connection that the certificate authenticates. */
export const getter = (creds: TellerCreds, accessToken: string): TellerGet =>
  (path) => tellerCall(creds, path, accessToken);

export const fetchTransactions = (
  creds: TellerCreds, accessToken: string, accountId: string, from: string,
): Promise<RemoteTransaction[]> => collectTransactions(getter(creds, accessToken), accountId, from);

export const fetchEnrollment = (
  creds: TellerCreds, accessToken: string, from: string,
  opts: { withTransactions?: boolean } = {},
): Promise<SyncPayload> => collectEnrollment(getter(creds, accessToken), from, opts);
