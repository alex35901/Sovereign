/**
 * The SimpleFIN bridge's upstream, reachable from any function here.
 *
 * Split out the same way Plaid's is, and for the same reason: the browser's
 * path goes through the proxy beside this file, and the scheduled job has no
 * browser. One copy of the protocol so the overnight pull and the hands-on one
 * cannot disagree about what the bridge said.
 *
 * The credential here belongs to the household rather than to the deployment.
 * A SimpleFIN access URL carries its own basic-auth credentials in it, so it
 * lives in the encrypted document and is passed in per call, the same way a
 * Plaid access token or a Tiingo key is. Nothing about it is stored here.
 */

const UPSTREAM_TIMEOUT_MS = 25_000;

/**
 * The most this will carry back from a bridge.
 *
 * Every other proxy here calls one fixed upstream; this one calls whatever
 * host the access URL names, which makes it the only place a caller chooses
 * where the request goes. The host is already held to a public name on https,
 * and this is the other half: a ceiling on what can be pulled through, so the
 * endpoint cannot be used to move something large from somewhere else. A year
 * of transactions across a household's accounts is a long way under it.
 */
const MAX_BODY_BYTES = 8_000_000;

/** Reads a response, or gives up rather than buffering whatever arrives. */
async function readCapped(res: Response): Promise<string | null> {
  const stated = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(stated) && stated > MAX_BODY_BYTES) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) return null;
  return new TextDecoder().decode(buf);
}

/**
 * Hosts an access URL may not point at, whatever it says.
 *
 * The access URL is typed in by a person and this server then fetches it, so
 * it is an outbound request whose target somebody else chooses. Left unchecked
 * that is a request this deployment will make to anything reachable from
 * inside it: a cloud provider's metadata endpoint, something on a private
 * network, a port on the machine itself. The rule in this codebase is that
 * anything landing in an outbound URL is held to a shape rather than escaped,
 * and for a whole host that shape is "a public name on https".
 *
 * Not an allowlist of one bridge, because SimpleFIN is a protocol and people
 * self-host it. The check is on where the request can reach, not on whose
 * bridge it is.
 */
const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

/** Dotted-quad and the IPv6 forms, so a literal address can be range-checked. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function privateAddress(host: string): boolean {
  const v4 = IPV4.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // Link-local, which is where a cloud metadata service answers.
    if (a === 169 && b === 254) return true;
    // Carrier-grade NAT, and anything above the unicast range.
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  // Bracketed in a URL; ::1 and the unique-local and link-local prefixes.
  const v6 = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!v6.includes(":")) return false;
  return v6 === "::1" || v6 === "::" || /^(fc|fd|fe80)/.test(v6);
}

/**
 * The URL this will actually fetch, or null.
 *
 * Returns a parsed URL rather than a boolean so a caller cannot check one
 * string and then fetch a different one.
 */
export function bridgeUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname;
  if (!host || BLOCKED_HOST.test(host)) return null;
  if (privateAddress(host)) return null;
  // A name with no dot in it is a host on the local network rather than one on
  // the internet, and is the shape a container's own service names take.
  if (!host.includes(".") && !host.includes(":")) return null;
  return url;
}

/**
 * Cents from the protocol's numeric string, without going through a float.
 *
 * "0.145" times a hundred is 14.499999999999998 in binary floating point, and
 * rounding that gives 14 where the answer is 15. A balance is read off the
 * digits instead: everything before the point is whole units, the two after it
 * are cents, and a third is rounded on its own.
 */
export function toCents(raw: unknown): number | null {
  const s = String(raw ?? "").trim().replace(/[,\s]/g, "");
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2] || "0";
  const frac = (m[3] ?? "").padEnd(3, "0");
  const cents = Number(whole) * 100 + Number(frac.slice(0, 2));
  // The third digit decides the second, which is the only rounding there is.
  const up = Number(frac[2]) >= 5 ? 1 : 0;
  const out = cents + up;
  return Number.isFinite(out) ? sign * out : null;
}

/** A setup token is base64 of the one-use URL that hands back the real one. */
export function claimUrlFrom(setupToken: string): URL | null {
  const raw = setupToken.trim();
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64").toString("utf8").trim();
  } catch {
    return null;
  }
  return bridgeUrl(decoded);
}

export interface SimplefinFailure { error: string; status?: number }

/**
 * The one-use exchange: a setup token in, an access URL out.
 *
 * The token can be claimed once. A second attempt with the same one is the
 * ordinary way this fails, and the bridge says so with a 403, so that is
 * passed on in those words rather than as "the request failed".
 */
export async function claim(setupToken: string): Promise<{ accessUrl: string } | SimplefinFailure> {
  const url = claimUrlFrom(setupToken);
  if (!url) {
    return {
      error: "That does not look like a SimpleFIN setup token. It is the long string of letters and "
        + "numbers the bridge shows you, not the address of a web page.",
      status: 400,
    };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-length": "0" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return { error: "The SimpleFIN bridge could not be reached.", status: 502 };
  }

  const read = await readCapped(res);
  if (read === null) return { error: "The bridge answered with more than this will carry.", status: 502 };
  const body = read.trim();
  if (res.status === 403) {
    return {
      error: "That setup token has already been used. A token can be claimed once: generate a new one "
        + "on the bridge and paste that.",
      status: 403,
    };
  }
  if (!res.ok) return { error: `The bridge refused the token (${res.status}).`, status: 502 };

  // What comes back is the access URL itself, in the body, as text. Held to
  // the same shape as anything else this server is about to fetch.
  if (!bridgeUrl(body)) {
    return { error: "The bridge answered with something that is not an access URL.", status: 502 };
  }
  return { accessUrl: body };
}

export interface RawAccount {
  id?: unknown;
  name?: unknown;
  currency?: unknown;
  balance?: unknown;
  "available-balance"?: unknown;
  "balance-date"?: unknown;
  org?: { name?: unknown; domain?: unknown; url?: unknown; id?: unknown };
  transactions?: RawTransaction[];
}

export interface RawTransaction {
  id?: unknown;
  posted?: unknown;
  transacted_at?: unknown;
  amount?: unknown;
  description?: unknown;
  payee?: unknown;
  memo?: unknown;
  pending?: unknown;
}

export interface Fetched { accounts: RawAccount[]; errors: string[] }

/**
 * Accounts and the transactions in a window.
 *
 * `start-date` is inclusive and `end-date` excludes its own second, both in
 * whole seconds since the epoch, which is what the protocol asks for. The
 * bridge reports per-institution trouble in `errors` and still answers with
 * whatever else it has, so a bank having a bad morning does not cost the
 * household the other five accounts.
 */
export async function fetchAccounts(
  accessUrl: string,
  from: Date,
  to: Date,
): Promise<Fetched | SimplefinFailure> {
  const base = bridgeUrl(accessUrl);
  if (!base) return { error: "That SimpleFIN access URL cannot be used.", status: 400 };

  // Joined onto whatever path the access URL already carries, rather than
  // replacing it: a bridge is free to live under a prefix.
  const url = new URL(`${base.pathname.replace(/\/$/, "")}/accounts`, base);
  url.search = "";
  url.searchParams.set("start-date", String(Math.floor(from.getTime() / 1000)));
  url.searchParams.set("end-date", String(Math.floor(to.getTime() / 1000)));

  // The credentials ride in the URL's own userinfo. Moved into a header so
  // they are not written into any log that records a request line.
  const auth = Buffer.from(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`).toString("base64");
  url.username = "";
  url.password = "";

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Basic ${auth}`, accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return { error: "The SimpleFIN bridge could not be reached.", status: 502 };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      error: "The SimpleFIN bridge rejected the saved access URL. Claim a new setup token on the bridge "
        + "and paste it in Settings.",
      status: 401,
    };
  }
  if (!res.ok) return { error: `The bridge answered ${res.status}.`, status: 502 };

  const read = await readCapped(res);
  if (read === null) return { error: "The bridge answered with more than this will carry.", status: 502 };

  let body: { accounts?: unknown; errors?: unknown };
  try {
    body = JSON.parse(read) as typeof body;
  } catch {
    return { error: "The bridge's answer was not JSON.", status: 502 };
  }

  return {
    accounts: Array.isArray(body.accounts) ? (body.accounts as RawAccount[]) : [],
    errors: Array.isArray(body.errors) ? body.errors.map((e) => String(e)).filter(Boolean) : [],
  };
}
