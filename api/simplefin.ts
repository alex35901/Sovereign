/**
 * Server-side proxy for SimpleFIN Bridge.
 *
 * Two reasons this can't live in the browser: the bridge sends no CORS headers,
 * and the access URL carries HTTP Basic credentials, which fetch() refuses to
 * send cross-origin. Credentials are never stored here — the client holds the
 * access URL and passes it in per request.
 */
export const config = { runtime: "nodejs" };

interface ClaimBody { action: "claim"; setupToken: string }
interface AccountsBody { action: "accounts"; accessUrl: string; startDate: number }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: ClaimBody | AccountsBody;
  try {
    body = (await req.json()) as ClaimBody | AccountsBody;
  } catch {
    return json({ error: "Malformed JSON body" }, 400);
  }

  try {
    if (body.action === "claim") {
      const claimUrl = Buffer.from(body.setupToken, "base64").toString("utf8").trim();
      if (!/^https:\/\//.test(claimUrl)) return json({ error: "That setup token doesn't decode to an https URL." }, 400);
      const res = await fetch(claimUrl, { method: "POST", headers: { "content-length": "0" } });
      const accessUrl = (await res.text()).trim();
      if (!res.ok || !/^https:\/\//.test(accessUrl)) {
        return json({ error: `Bridge rejected the token (${res.status}). Setup tokens are single-use — generate a fresh one.` }, 400);
      }
      return json({ accessUrl });
    }

    if (body.action === "accounts") {
      const url = new URL(body.accessUrl);
      if (url.protocol !== "https:") return json({ error: "Access URL must be https." }, 400);
      const auth = "Basic " + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64");
      url.username = "";
      url.password = "";
      const target = new URL(`${url.toString().replace(/\/$/, "")}/accounts`);
      target.searchParams.set("start-date", String(body.startDate));
      const res = await fetch(target, { headers: { Authorization: auth } });
      const text = await res.text();
      if (!res.ok) return json({ error: `Bridge returned ${res.status}: ${text.slice(0, 300)}` }, 502);
      return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Upstream request failed" }, 502);
  }
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
