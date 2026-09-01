/**
 * Direct calls to the SimpleFIN bridge, from the server.
 *
 * Shared by the browser proxy and the scheduled job, so both reach the bridge
 * the same way. The access URL carries HTTP Basic credentials in its userinfo,
 * which have to be lifted into a header — fetch will not send them otherwise.
 */

export const UPSTREAM_TIMEOUT_MS = 15_000;

export class BridgeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

/** Trades a single-use setup token for a durable access URL. */
export async function claim(setupToken: string): Promise<string> {
  const claimUrl = Buffer.from(setupToken, "base64").toString("utf8").trim();
  if (!/^https:\/\//.test(claimUrl)) {
    throw new BridgeError(400, "That setup token doesn't decode to an https URL. Copy the whole token — they're long and easy to truncate.");
  }
  const upstream = await fetch(claimUrl, {
    method: "POST",
    headers: { "content-length": "0" },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const accessUrl = (await upstream.text()).trim();
  if (!upstream.ok || !/^https:\/\//.test(accessUrl)) {
    throw new BridgeError(400, `Bridge rejected the token (${upstream.status}). Setup tokens are single-use — generate a fresh one, and check the bridge shows an active subscription or trial.`);
  }
  return accessUrl;
}

/** Raw /accounts JSON, as text so the proxy can pass it through untouched. */
export async function fetchAccountsText(accessUrl: string, startDate: number): Promise<string> {
  const url = new URL(accessUrl);
  if (url.protocol !== "https:") throw new BridgeError(400, "Access URL must be https.");
  const auth = "Basic " + Buffer.from(
    `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
  ).toString("base64");
  url.username = "";
  url.password = "";
  const target = new URL(`${url.toString().replace(/\/$/, "")}/accounts`);
  target.searchParams.set("start-date", String(startDate));

  const upstream = await fetch(target, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const text = await upstream.text();
  if (!upstream.ok) throw new BridgeError(502, `Bridge returned ${upstream.status}: ${text.slice(0, 300)}`);
  return text;
}
