import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

/**
 * A brand's icon, fetched on the browser's behalf.
 *
 * It went through the icon service directly at first, and two things were
 * wrong with that. The service saw the reader's address alongside the name of
 * every shop they use, which is the leak the whole app exists to avoid. And
 * when it has no icon for a domain it answers with a placeholder rather than a
 * 404 — a grey circle, or a blank square — so the page's onError never fired
 * and Starbucks and Costco showed marks belonging to nobody.
 *
 * Doing it here fixes both. The request comes from the deployment, not from
 * the reader; and the bytes can be looked at before they are passed on, so a
 * placeholder becomes the 404 it should have been and the lettered avatar
 * takes over.
 *
 * Two sources, tried in order. Neither is asked anything the other wasn't.
 */
export const config = { runtime: "nodejs", maxDuration: 15 };

const SOURCES = [
  (domain: string) => `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
];

/**
 * A domain that cannot exist, used to ask each source what "I have nothing"
 * looks like. `.invalid` is reserved for exactly this by RFC 2606, so no
 * amount of registration can ever make it resolve.
 */
const NOTHING = "no-such-brand-a7f3c1.invalid";

const TIMEOUT_MS = 6_000;

/** Below this an .ico is a header and a couple of blank pixels, never a mark. */
const MIN_BYTES = 100;

/**
 * A week in the browser's cache, and a week in Vercel's.
 *
 * `s-maxage` is the half that matters for the bill: without it every browser
 * that has not seen a mark before invokes the function and pulls the bytes
 * from the origin again, and that traffic is metered. With it the CDN answers
 * and the function is asked about each brand roughly once.
 */
const CACHE = "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400";

/** Hostnames only: letters, digits, dots and dashes, and at least one dot. */
const isDomain = (d: string): boolean =>
  d.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * What each source returns when it has nothing, learned rather than hardcoded.
 *
 * Asking for a domain that cannot exist is the only reliable way to find out:
 * the placeholder is whatever comes back, and it changes when they change it.
 * Memoised for the life of the instance, and never allowed to fail the request
 * it was learned during.
 */
const placeholders = new Map<number, Promise<string | null>>();

function placeholderFor(index: number): Promise<string | null> {
  const held = placeholders.get(index);
  if (held) return held;
  const learning = (async (): Promise<string | null> => {
    const got = await load(SOURCES[index]!(NOTHING));
    return got ? digest(got.bytes) : null;
  })().catch(() => null);
  placeholders.set(index, learning);
  return learning;
}

/** Test seam: what each source hands out for nothing is learned once per instance. */
export const forgetPlaceholders = (): void => { placeholders.clear(); };

async function load(url: string): Promise<{ bytes: Buffer; type: string } | null> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  return bytes.length >= MIN_BYTES ? { bytes, type } : null;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const fail = (status: number, why: string) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    // Cached as well: a brand with no mark anywhere should not be asked about
    // again on every page that lists it.
    res.setHeader("cache-control", status === 404 ? CACHE : "no-store");
    res.end(JSON.stringify({ error: why }));
  };

  if (req.method !== "GET") return fail(405, "GET only");

  const domain = (new URL(req.url ?? "/", "http://x").searchParams.get("domain") ?? "").trim().toLowerCase();
  // Checked rather than escaped: this becomes a hostname in an outbound URL.
  if (!isDomain(domain)) return fail(400, "Not a domain.");

  for (let i = 0; i < SOURCES.length; i++) {
    const got = await load(SOURCES[i]!(domain));
    if (!got) continue;
    // The source answered, but with the same thing it hands out for a domain
    // that cannot exist — which is to say, with nothing.
    if (digest(got.bytes) === await placeholderFor(i)) continue;

    res.statusCode = 200;
    res.setHeader("content-type", got.type);
    res.setHeader("cache-control", CACHE);
    res.end(got.bytes);
    return;
  }

  return fail(404, "No icon for that domain.");
}
