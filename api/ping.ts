/**
 * A function with no imports at all.
 *
 * When a serverless function dies before its own code runs, the platform
 * answers FUNCTION_INVOCATION_FAILED and nothing the function might have said
 * can reach the browser. This one has nothing to load, so it always answers —
 * and it reports whether the pieces the real endpoints depend on can be loaded,
 * which is what turns "it crashed" into a specific cause.
 *
 * It returns no values from the environment, only which names are set, and it
 * says even that much only to somebody holding the passphrase. A deployment
 * with no passphrase configured hands out nothing: that used to be the one
 * state where the guard below was skipped, which left the diagnostics open to
 * anyone who found the URL.
 */

type Req = { method?: string; url?: string; headers: Record<string, string | string[] | undefined> };
type Res = { statusCode: number; setHeader(k: string, v: string): void; end(body?: string): void };

const NAMES = [
  "DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "NEON_DATABASE_URL",
  "POSTGRES_URL_NON_POOLING", "DATABASE_URL_UNPOOLED", "SYNC_PASSPHRASE", "CRON_SECRET",
];

const reason = (err: unknown): string => {
  const e = err as { message?: string; code?: string };
  const code = typeof e?.code === "string" ? ` [${e.code}]` : "";
  return `${e?.message ? String(e.message) : String(err)}${code}`;
};

/**
 * Fixed-time string comparison, written out rather than imported.
 *
 * The rest of the app compares secrets through timingSafeEqual in ./_auth, and
 * for the same reason: a plain !== returns as soon as two bytes differ, which
 * is a measurable read on how much of a guess was right. This file is the one
 * that must answer when imports are the thing that is broken, so it cannot
 * reach for that module and does the work itself. Length is compared first and
 * separately, which is the one thing this cannot hide; the passphrase's length
 * is not the secret.
 */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
  };

  // The guard comes first now, before anything is read out of the environment,
  // so there is no assembled answer sitting around to be returned by mistake.
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const supplied = /^Bearer\s+(.+)$/i.exec((header ?? "").trim())?.[1];
  let expected = "";
  try {
    expected = (process.env.SYNC_PASSPHRASE ?? "").trim();
  } catch {
    // A process with no readable environment cannot authenticate anybody, so
    // it is in the same position as one with no passphrase set.
  }

  // No passphrase configured is not open house. It is the state with nothing
  // to check against, so nothing is handed out beyond which state it is in --
  // which is what somebody setting this up for the first time needs, and tells
  // a stranger nothing, because /api/db refuses everything in this state too.
  if (!expected) {
    return send(200, {
      alive: true,
      needsPassphrase: true,
      hint: "Set SYNC_PASSPHRASE in Vercel and redeploy. Until then nothing here is readable, including this.",
    });
  }
  if (!supplied || !sameSecret(supplied, expected)) {
    return send(401, { alive: true, error: "That passphrase doesn't match." });
  }

  const out: Record<string, unknown> = { alive: true };
  try {
    out.node = process.version;
    out.region = process.env.VERCEL_REGION ?? null;
    out.envSet = NAMES.filter((n) => Boolean(process.env[n]?.trim()));
  } catch (err) {
    out.envError = reason(err);
  }

  for (const [label, load] of [
    ["pg", () => import("pg")],
    ["node:crypto", () => import("node:crypto")],
    ["./_auth", () => import("./_auth.js")],
    ["./_store", () => import("./_store.js")],
  ] as [string, () => Promise<unknown>][]) {
    try {
      const mod = (await load()) as Record<string, unknown> & { default?: Record<string, unknown> };
      out[label] = {
        ok: true,
        exports: Object.keys(mod).slice(0, 8),
        defaultExports: mod.default && typeof mod.default === "object" ? Object.keys(mod.default).slice(0, 8) : null,
      };
    } catch (err) {
      out[label] = { ok: false, error: reason(err) };
    }
  }

  send(200, out);
}
