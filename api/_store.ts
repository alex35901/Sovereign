import { Pool } from "pg";

/**
 * The one budget document, held server-side so every device sees the same data
 * and a scheduled job can update it while no browser is open.
 *
 * One row, one JSON document. The app already keeps its whole state in a single
 * immutable object, so there is nothing to gain from shredding it into tables —
 * and a document keeps the client and the cron reading exactly the same shape.
 */

const CONNECTION_VARS = ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "NEON_DATABASE_URL"];

export function connectionString(): string | null {
  for (const name of CONNECTION_VARS) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  return null;
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

function db(): Pool {
  const url = connectionString();
  if (!url) throw new Error("No database is configured.");
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      // Hosted Postgres requires TLS; its certificate chain isn't one Node
      // ships, which is the usual reason a first deploy fails to connect.
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", () => { pool = null; });
  }
  return pool;
}

/** Idempotent, so first use of a fresh database just works. */
async function ensureTable(): Promise<void> {
  await db().query(`
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
  const { rows } = await db().query(
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
}

/**
 * Writes the document, refusing if it has moved on since `baseVersion`.
 *
 * `baseVersion` of 0 means "only if nothing is there yet"; null forces the
 * write, which the cron uses because it always reads immediately beforehand.
 */
export async function writeDoc(doc: unknown, baseVersion: number | null, by: string): Promise<WriteResult> {
  await ensureTable();
  const client = await db().connect();
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
