// Type-only: erased at compile time, so nothing is required at module load.
import type { Pool } from "pg";
import { isEnvelope } from "../src/lib/crypto.js";

/**
 * The one budget document, held server-side so every device sees the same data
 * and a scheduled job can update it while no browser is open.
 *
 * One row, one JSON document. The app already keeps its whole state in a single
 * immutable object, so there is nothing to gain from shredding it into tables —
 * and a document keeps the client and the cron reading exactly the same shape.
 */

/**
 * Every name the hosted Postgres providers use, pooled ones first: a serverless
 * function opens a connection per cold start, which is exactly what a pooler is
 * for.
 */
const CONNECTION_VARS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "NEON_DATABASE_URL",
  "POSTGRES_URL_NON_POOLING",
  "DATABASE_URL_UNPOOLED",
];

/** pg speaks the Postgres wire protocol; a proxy URL of any other scheme is not it. */
const DIALABLE = /^postgres(ql)?:\/\//i;

export interface Connection {
  url: string | null;
  /** Something was set, but not a URL pg can dial — worth saying so by name. */
  unusable?: { name: string; scheme: string };
}

/**
 * Picks the connection string, skipping values pg cannot use.
 *
 * Prisma Postgres, for one, sets DATABASE_URL to a `prisma+postgres://`
 * accelerate URL. Dialling that fails deep inside the driver with nothing that
 * points at the cause, so it is caught here and named instead.
 */
export function findConnection(env: NodeJS.ProcessEnv = process.env): Connection {
  let unusable: Connection["unusable"];
  for (const name of CONNECTION_VARS) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (DIALABLE.test(value)) return { url: value };
    unusable ??= { name, scheme: value.split(":")[0] };
  }
  return { url: null, unusable };
}

export function connectionString(): string | null {
  return findConnection().url;
}

/** The winning variable and its value, for reporting which one was used. */
function findConnectionNamed(env: NodeJS.ProcessEnv = process.env): { name: string; value: string } | null {
  for (const name of CONNECTION_VARS) {
    const value = env[name]?.trim();
    if (value && DIALABLE.test(value)) return { name, value };
  }
  return null;
}

export interface StoreDiagnosis {
  driver: { ok: boolean; error: string | null };
  variable: string | null;
  host: string | null;
  database: string | null;
  ssl: boolean;
  connect: { ok: boolean; error: string | null; code: string | null };
  table: { ok: boolean; error: string | null };
  documents: number | null;
}

const describeError = (err: unknown): { error: string; code: string | null } => {
  const e = err as { message?: string; code?: string; name?: string };
  return {
    error: e?.message ? String(e.message) : "unknown failure",
    code: typeof e?.code === "string" ? e.code : null,
  };
};

/**
 * What the function can actually see and reach.
 *
 * The host and database name travel; the user and password never do. Written
 * because a failed connection otherwise surfaces as a bare 500, which says
 * nothing about which of the half-dozen possible causes it was.
 */
export async function diagnose(): Promise<StoreDiagnosis> {
  const found = findConnectionNamed();
  const rejected = found ? undefined : findConnection().unusable;
  const out: StoreDiagnosis = {
    driver: { ok: false, error: null },
    variable: found?.name ?? null,
    host: null,
    database: null,
    ssl: false,
    connect: {
      ok: false,
      error: found
        ? null
        : rejected
          ? `${rejected.name} holds a ${rejected.scheme}: URL, which is not a Postgres connection.`
          : "No connection string is set.",
      code: null,
    },
    table: { ok: false, error: null },
    documents: null,
  };
  // Checked first and on its own: a driver that will not load is a different
  // problem from a database that will not answer, and looks identical from
  // outside if they are reported together.
  try {
    await loadPool();
    out.driver.ok = true;
  } catch (err) {
    out.driver.error = describeError(err).error;
    return out;
  }

  if (!found) return out;

  try {
    const parsed = new URL(found.value);
    out.host = parsed.host;
    out.database = parsed.pathname.replace(/^\//, "") || null;
  } catch {
    out.connect.error = "The connection string isn't a URL this can parse.";
    return out;
  }
  out.ssl = !/localhost|127\.0\.0\.1/.test(found.value);

  try {
    const { rows } = await (await db()).query("SELECT 1 AS ok");
    out.connect.ok = rows.length === 1;
  } catch (err) {
    Object.assign(out.connect, describeError(err));
    return out;
  }

  try {
    await ensureTable();
    const { rows } = await (await db()).query("SELECT count(*)::int AS n FROM budget_document");
    out.table.ok = true;
    out.documents = Number((rows[0] as { n: number }).n);
  } catch (err) {
    out.table.error = describeError(err).error;
  }
  return out;
}

export interface StoredDoc {
  version: number;
  updatedAt: string;
  updatedBy: string;
  doc: unknown;
}

const ROW_ID = 1;

/**
 * One pool per warm function instance. Serverless invocations reuse the module,
 * so building a pool per request would leak connections until the database
 * refused new ones.
 */
let pool: Pool | null = null;

/**
 * The driver is loaded on demand rather than at module scope.
 *
 * A serverless function whose import graph fails to resolve dies before any of
 * this code runs, and the platform answers with FUNCTION_INVOCATION_FAILED —
 * a page that names neither the module nor the reason. Loading it here turns
 * that into an ordinary error this app can report.
 */
async function loadPool(): Promise<new (config: unknown) => Pool> {
  try {
    const pg = await import("pg");
    const Ctor = (pg as { Pool?: unknown; default?: { Pool?: unknown } }).Pool
      ?? (pg as { default?: { Pool?: unknown } }).default?.Pool;
    if (typeof Ctor !== "function") throw new Error("the pg module exported no Pool");
    return Ctor as new (config: unknown) => Pool;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not load the Postgres driver: ${why}`);
  }
}

export async function db(): Promise<Pool> {
  const url = connectionString();
  if (!url) throw new Error("No database is configured.");
  if (!pool) {
    const PoolCtor = await loadPool();
    pool = new PoolCtor({
      connectionString: url,
      // Hosted Postgres requires TLS; its certificate chain isn't one Node
      // ships, which is the usual reason a first deploy fails to connect.
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    // An unhandled 'error' event on a pool takes the whole process down.
    pool.on("error", () => { pool = null; });
  }
  return pool;
}

/** Idempotent, so first use of a fresh database just works. */
async function ensureTable(): Promise<void> {
  await (await db()).query(`
    CREATE TABLE IF NOT EXISTS budget_document (
      id integer PRIMARY KEY,
      version integer NOT NULL,
      updated_at timestamptz NOT NULL,
      updated_by text NOT NULL,
      doc jsonb NOT NULL
    )
  `);
}

export async function readDoc(): Promise<StoredDoc | null> {
  await ensureTable();
  const { rows } = await (await db()).query(
    "SELECT version, updated_at, updated_by, doc FROM budget_document WHERE id = $1",
    [ROW_ID],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    version: Number(row.version),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    updatedBy: String(row.updated_by),
    doc: row.doc,
  };
}

/** Whether a write may proceed: null forces it, a number must match exactly. */
export function writeAllowed(currentVersion: number, baseVersion: number | null): boolean {
  return baseVersion === null || currentVersion === baseVersion;
}

export interface WriteResult {
  ok: boolean;
  /** Set when the write was refused because someone else got there first. */
  conflict?: StoredDoc;
  stored?: StoredDoc;
  /**
   * Set when the write would have replaced an encrypted document with a
   * readable one. A browser that has never been unlocked still holds its own
   * plaintext copy, and saving that as-is would strip the encryption off every
   * other device's document and overwrite it with whatever that browser had.
   */
  wouldDecrypt?: boolean;
}

/**
 * Writes the document, refusing if it has moved on since `baseVersion`.
 *
 * `baseVersion` of 0 means "only if nothing is there yet"; null forces the
 * write, which the cron uses because it always reads immediately beforehand.
 */
export async function writeDoc(doc: unknown, baseVersion: number | null, by: string): Promise<WriteResult> {
  await ensureTable();
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    // Locked for the transaction: two devices saving at the same instant must
    // not both read version 4 and both write version 5.
    const { rows } = await client.query(
      "SELECT version, updated_at, updated_by, doc FROM budget_document WHERE id = $1 FOR UPDATE",
      [ROW_ID],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const currentVersion = row ? Number(row.version) : 0;

    // A one-way ratchet, checked inside the same locked transaction as the
    // version so it cannot be raced: once a document is sealed, nothing may
    // put a readable one back in its place.
    if (row && isEnvelope(row.doc) && !isEnvelope(doc)) {
      await client.query("ROLLBACK");
      return { ok: false, wouldDecrypt: true };
    }

    if (!writeAllowed(currentVersion, baseVersion)) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        conflict: row
          ? {
              version: currentVersion,
              updatedAt: new Date(row.updated_at as string).toISOString(),
              updatedBy: String(row.updated_by),
              doc: row.doc,
            }
          : undefined,
      };
    }

    const version = currentVersion + 1;
    const updatedAt = new Date().toISOString();
    await client.query(
      `INSERT INTO budget_document (id, version, updated_at, updated_by, doc)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         version = EXCLUDED.version,
         updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by,
         doc = EXCLUDED.doc`,
      [ROW_ID, version, updatedAt, by, JSON.stringify(doc)],
    );
    await client.query("COMMIT");
    return { ok: true, stored: { version, updatedAt, updatedBy: by, doc } };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ── the drop box ──────────────────────────────────────────────────────── */

/**
 * What the scheduled job leaves behind when the document is encrypted.
 *
 * It cannot merge into a document it cannot read, so instead it encrypts what
 * it pulled to the public key stored in the envelope and queues it here. Only
 * a browser holding the passphrase can open these rows; this server wrote them
 * and still cannot read them back.
 */
export interface QueuedPull {
  id: number;
  createdAt: string;
  epk: string;
  iv: string;
  ct: string;
}

async function ensureQueue(): Promise<void> {
  await (await db()).query(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id bigserial PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      epk text NOT NULL,
      iv text NOT NULL,
      ct text NOT NULL
    )
  `);
}

export async function queuePull(box: { epk: string; iv: string; ct: string }): Promise<number> {
  await ensureQueue();
  const { rows } = await (await db()).query(
    "INSERT INTO sync_queue (epk, iv, ct) VALUES ($1, $2, $3) RETURNING id",
    [box.epk, box.iv, box.ct],
  );
  return Number((rows[0] as { id: number }).id);
}

/** Oldest first, so a browser applies overnight pulls in the order they happened. */
export async function readQueue(limit = 50): Promise<QueuedPull[]> {
  await ensureQueue();
  const { rows } = await (await db()).query(
    "SELECT id, created_at, epk, iv, ct FROM sync_queue ORDER BY id ASC LIMIT $1",
    [limit],
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    createdAt: new Date(r.created_at as string).toISOString(),
    epk: String(r.epk),
    iv: String(r.iv),
    ct: String(r.ct),
  }));
}

/** Dropped only once a browser has merged them in and saved the result. */
export async function clearQueue(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  await ensureQueue();
  const { rowCount } = await (await db()).query(
    "DELETE FROM sync_queue WHERE id = ANY($1::bigint[])",
    [ids],
  );
  return rowCount ?? 0;
}

/**
 * Stops the queue growing without bound if nobody opens the app for months.
 * A pull older than this is stale anyway — the next one supersedes it.
 */
export async function trimQueue(keepDays = 30): Promise<number> {
  await ensureQueue();
  const { rowCount } = await (await db()).query(
    "DELETE FROM sync_queue WHERE created_at < now() - ($1 || ' days')::interval",
    [String(keepDays)],
  );
  return rowCount ?? 0;
}
