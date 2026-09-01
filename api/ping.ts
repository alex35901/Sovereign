/**
 * A function with no imports at all.
 *
 * When a serverless function dies before its own code runs, the platform
 * answers FUNCTION_INVOCATION_FAILED and nothing the function might have said
 * can reach the browser. This one has nothing to load, so it always answers —
 * and it reports whether the pieces the real endpoints depend on can be loaded,
 * which is what turns "it crashed" into a specific cause.
 *
 * It returns no values from the environment, only which names are set.
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

export default async function handler(req: Req, res: Res): Promise<void> {
  const out: Record<string, unknown> = { alive: true };

  try {
    out.node = process.version;
    out.region = process.env.VERCEL_REGION ?? null;
    out.envSet = NAMES.filter((n) => Boolean(process.env[n]?.trim()));
  } catch (err) {
    out.envError = reason(err);
  }

  // Guard the rest: knowing which variables are set is dull, but there is no
  // reason to hand it out to anyone who finds the URL.
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const supplied = /^Bearer\s+(.+)$/i.exec((header ?? "").trim())?.[1];
  const expected = (process.env.SYNC_PASSPHRASE ?? "").trim();
  if (expected && supplied !== expected) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ alive: true, error: "That passphrase doesn't match." }));
    return;
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

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(out));
}
