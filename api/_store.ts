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
  /**
   * How much room the stored copy is taking.
   *
   * A free Neon project gets half a gigabyte, and the only place that number
   * was visible was Neon's own console. `bytes` is the whole database as
   * Postgres measures it and `documentBytes` is the document table alone,
   * including the out-of-line storage the document itself lives in. Neon also
   * counts a window of recent history towards the limit, which Postgres cannot
   * see from in here, so this is the floor rather than the bill.
   */
  storage: { bytes: number | null; documentBytes: number | null };
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
    storage: { bytes: null, documentBytes: null },
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
    const { rows } = await documentTable.guard(async () =>
      (await db()).query("SELECT count(*)::int AS n FROM budget_document"),
    );
    out.table.ok = true;
    out.documents = Number((rows[0] as { n: number }).n);
  } catch (err) {
    out.table.error = describeError(err).error;
  }

  // Its own try, and after the table check rather than inside it: a role
  // without permission to measure the database is not a broken installation,
  // and a number nobody can read is not worth failing a diagnosis over.
  try {
    const { rows } = await (await db()).query(
      `SELECT pg_database_size(current_database())::bigint AS total,
              pg_total_relation_size('budget_document')::bigint AS doc`,
    );
    const row = rows[0] as { total: string; doc: string };
    out.storage = { bytes: Number(row.total), documentBytes: Number(row.doc) };
  } catch { /* the size is a nicety; the rest of the diagnosis is not */ }
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

/** Long enough for a database that is awake, short enough to leave a retry. */
const CONNECT_MS = 4_000;

/**
 * Whether a failure is the database being asleep rather than wrong.
 *
 * Serverless Postgres suspends itself when nobody has asked it anything for a
 * few minutes, and the request that wakes it can time out while it does. That
 * is not an error to report, it is one to make again a moment later.
 */
const isColdStart = (err: unknown): boolean => {
  const m = err instanceof Error ? `${err.message}` : String(err);
  return /timeout|ETIMEDOUT|ECONNRESET|Connection terminated|starting up|not yet accepting/i.test(m);
};

/**
 * Runs a query, and gives a sleeping database one more chance.
 *
 * Every write in here goes through this. The first save after a quiet half
 * hour was landing on a suspended database, taking the whole function's budget
 * to find out, and coming back as "could not save" with no reason - while the
 * retry a minute later worked, because by then the database was up. One
 * attempt more, inside the same request, turns that into a save that simply
 * took a moment.
 */
export async function withWake<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isColdStart(err)) throw err;
    // A pool that failed to connect holds no usable clients.
    pool = null;
    return run();
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
      // Shorter than the function is allowed to run, and deliberately so. It
      // used to be ten seconds, which is exactly how long a serverless
      // function gets on the free plan: the connection attempt could never
      // give up before the platform killed the function, so a database that
      // was slow to answer came back as a bare 504 with nothing in it. Failing
      // at four leaves room to say what happened, and room to try again.
      connectionTimeoutMillis: CONNECT_MS,
    });
    // An unhandled 'error' event on a pool takes the whole process down.
    pool.on("error", () => { pool = null; });
  }
  return pool;
}

/** Postgres for "that table is not there". */
const UNDEFINED_TABLE = "42P01";

export interface OnDemandTable {
  /** Makes sure the table is there. */
  ensure(): Promise<void>;
  /** Unremembers it, so the next `ensure` asks the database again. */
  forget(): void;
  /** Runs something against it, rebuilding it once if it has gone. */
  guard<T>(run: () => Promise<T>): Promise<T>;
}

/**
 * The same guarantee across more than one table, for a query that reads two.
 *
 * Which table was missing is not in the error in any form worth parsing, so a
 * 42P01 forgets all of them. Rebuilding one that was there anyway costs a
 * statement that does nothing.
 */
export async function guardTables<T>(tables: readonly OnDemandTable[], run: () => Promise<T>): Promise<T> {
  await Promise.all(tables.map((t) => t.ensure()));
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: string })?.code !== UNDEFINED_TABLE) throw err;
    // Once, because a second failure is a real one.
    for (const t of tables) t.forget();
    await Promise.all(tables.map((t) => t.ensure()));
    return run();
  }
}

/**
 * A table this app creates on demand, built once per warm instance.
 *
 * Idempotent, so first use of a fresh database just works, and the one place
 * a sleeping database has to be woken - nothing below it needs to know.
 *
 * Every read and every write used to open with CREATE TABLE IF NOT EXISTS.
 * That is a round trip and a catalogue lookup to be told something settled the
 * first time, on every single request. It is issued once per instance now.
 *
 * Remembering is only safe because forgetting is cheap: if the table turns out
 * not to be there after all, `guard` clears the memo and asks again. A memo
 * that could be wrong about the one thing it promises would be worse than no
 * memo, and a test suite that drops the table between cases is the proof that
 * "nothing ever drops it" was an assumption rather than a fact.
 */
export function onDemandTable(ddl: string): OnDemandTable {
  let ready: Promise<void> | null = null;

  const ensure = async (): Promise<void> => {
    if (!ready) {
      ready = withWake(async () => {
        try {
          await (await db()).query(ddl);
        } catch (err) {
          // CREATE TABLE IF NOT EXISTS is not actually safe against
          // concurrency: Postgres checks the catalogue and then inserts into
          // it, and two statements that interleave between those steps make
          // the second fail with a duplicate key on pg_type rather than
          // quietly doing nothing. A serverless function that cold-starts
          // under a burst hits this. Losing that race means the table is
          // there, which is the only thing this needed.
          if (!/duplicate key|already exists/i.test(String(err))) throw err;
        }
      }).catch((err: unknown) => {
        // A failure is forgotten, so a database that was asleep or unreachable
        // is asked again next time rather than written off for the life of the
        // instance.
        ready = null;
        throw err;
      });
    }
    await ready;
  };

  const self: OnDemandTable = {
    ensure,
    forget: () => { ready = null; },
    guard: (run) => guardTables([self], run),
  };
  return self;
}

const documentTable = onDemandTable(`
  CREATE TABLE IF NOT EXISTS budget_document (
    id integer PRIMARY KEY,
    version integer NOT NULL,
    updated_at timestamptz NOT NULL,
    updated_by text NOT NULL,
    doc jsonb NOT NULL
  )
`);

/**
 * What the document used to be.
 *
 * The one row is overwritten in place, which is cheap and was fine until the
 * day a device holding an old copy saved it over a day's work. There was then
 * no way back at all: no history, no backup, and a single row that had already
 * been replaced. Storage is not the constraint here - a budget is a fraction of
 * a megabyte and the free tier has half a gigabyte - so the versions that were
 * about to be thrown away are kept instead.
 *
 * Trimmed to KEEP, oldest first, so it cannot grow without bound.
 */
const historyTable = onDemandTable(`
  CREATE TABLE IF NOT EXISTS budget_history (
    version integer PRIMARY KEY,
    updated_at timestamptz NOT NULL,
    updated_by text NOT NULL,
    doc jsonb NOT NULL
  )
`);

/** How many past versions to keep. Deep enough to cover a weekend of saves. */
export const KEEP_VERSIONS = 40;

export interface HistoryEntry {
  version: number;
  updatedAt: string;
  updatedBy: string;
  /** Whether that version was sealed, so a list can be shown without a key. */
  sealed: boolean;
  /** Roughly how big it was, which is the one clue a locked browser can read. */
  bytes: number;
}

/** The versions available to go back to, newest first. */
export async function listHistory(limit = KEEP_VERSIONS): Promise<HistoryEntry[]> {
  const { rows } = await historyTable.guard(async () => (await db()).query(
    `SELECT version, updated_at, updated_by, (doc ? 'ct') AS sealed,
            pg_column_size(doc) AS bytes
       FROM budget_history ORDER BY version DESC LIMIT $1`,
    [limit],
  ));
  return (rows as Record<string, unknown>[]).map((r) => ({
    version: Number(r.version),
    updatedAt: new Date(r.updated_at as string).toISOString(),
    updatedBy: String(r.updated_by),
    sealed: r.sealed === true,
    bytes: Number(r.bytes ?? 0),
  }));
}

/** One past version in full, or null when it has been trimmed away. */
export async function readHistory(version: number): Promise<StoredDoc | null> {
  const { rows } = await historyTable.guard(async () => (await db()).query(
    "SELECT version, updated_at, updated_by, doc FROM budget_history WHERE version = $1",
    [version],
  ));
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    version: Number(row.version),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    updatedBy: String(row.updated_by),
    doc: row.doc,
  };
}

export interface DocMeta {
  version: number;
  updatedAt: string;
  updatedBy: string;
  /** Whether the stored document is sealed, answered without fetching it. */
  sealed: boolean;
  /** How many overnight pulls are waiting in the queue. */
  queued: number;
}

/**
 * Everything about the stored document except the document.
 *
 * The reason this exists: the browsers poll once a minute to notice edits made
 * elsewhere, and each poll used to drag the whole document out of the database
 * and throw it away when the version had not moved. Half a megabyte, sixty
 * times an hour, per open tab — which is how a 5 GB monthly allowance goes in
 * two days without anybody doing anything.
 *
 * `doc ? 'ct'` is evaluated by Postgres and comes back as one boolean, so
 * asking whether the document is sealed costs nothing either.
 *
 * The size of the queue rides along for the same reason. The browser used to
 * ask for the queue itself after every poll, which is a second request, a
 * second function, a second connection and four more statements - to be told,
 * on all but a handful of days a year, that there is nothing in it. A count
 * over a table that holds at most fifty rows answers that here.
 */
export async function readMeta(): Promise<DocMeta | null> {
  const { rows } = await guardTables([documentTable, queueTable], async () => (await db()).query(
    `SELECT version, updated_at, updated_by, (doc ? 'ct') AS sealed,
            (SELECT count(*)::int FROM sync_queue) AS queued
       FROM budget_document WHERE id = $1`,
    [ROW_ID],
  ));
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    version: Number(row.version),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    updatedBy: String(row.updated_by),
    sealed: row.sealed === true,
    queued: Number(row.queued ?? 0),
  };
}

export interface DocSeal {
  version: number;
  updatedAt: string;
  updatedBy: string;
  /** Whether the stored document is an envelope, answered without opening it. */
  sealed: boolean;
  /** The public key it carries, for sealing a pull nobody here can read. */
  pub: string | null;
  /**
   * The envelope with its ciphertext left behind.
   *
   * Everything a passphrase needs to derive the key and unwrap the private
   * one, and nothing that key would open. Null for a document that is not
   * sealed, which matters: `doc - 'ct'` on a plain document is the whole
   * document, which is the opposite of the point.
   */
  header: Record<string, unknown> | null;
}

/**
 * Just enough of a sealed document to leave something for it in the queue.
 *
 * The scheduled job used to pull the whole document down to find out it could
 * not read it. On an encrypted budget that is a megabyte and a half of
 * ciphertext fetched, looked at once and thrown away, every single night - and
 * the only part of it the job can use is the public key in the envelope, which
 * is a hundred bytes. Postgres picks that out and sends that.
 */
export async function readSeal(): Promise<DocSeal | null> {
  const { rows } = await documentTable.guard(async () => (await db()).query(
    `SELECT version, updated_at, updated_by,
            CASE WHEN jsonb_typeof(doc->'ct') = 'string' THEN doc - 'ct' END AS header,
            jsonb_typeof(doc->'ct') = 'string' AS ct_is_string
       FROM budget_document WHERE id = $1`,
    [ROW_ID],
  ));
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const header = (row.header ?? null) as Record<string, unknown> | null;
  // Answered by the same predicate the rest of the app uses, rather than by a
  // second copy of it written in SQL. The ciphertext is the one field
  // deliberately left behind, so it is stood in for by what was asked of it:
  // whether it is a string. Two predicates that have to agree about what an
  // envelope is would eventually stop agreeing, and the cost of being wrong
  // here is a merge written over an encrypted document.
  const sealed = isEnvelope({ ...header, ct: row.ct_is_string === true ? "" : undefined });
  return {
    version: Number(row.version),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    updatedBy: String(row.updated_by),
    sealed,
    pub: sealed && typeof header?.pub === "string" ? header.pub : null,
    header: sealed ? header : null,
  };
}

export async function readDoc(): Promise<StoredDoc | null> {
  const { rows } = await documentTable.guard(async () => (await db()).query(
    "SELECT version, updated_at, updated_by, doc FROM budget_document WHERE id = $1",
    [ROW_ID],
  ));
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
  // Both tables, because the write touches both and a missing one must heal
  // rather than fail the save.
  return guardTables([documentTable, historyTable], async () => {
    const client = await (await db()).connect();
    try {
      await client.query("BEGIN");
      /**
       * Locked for the transaction: two devices saving at the same instant must
       * not both read version 4 and both write version 5.
       *
       * The document itself is deliberately not selected here. Every save takes
       * this lock, and pulling a megabyte of JSON across the wire to look at a
       * version number and throw it away again is the most expensive thing this
       * app did. The two questions actually asked of the stored row are its
       * version and whether it is sealed, and Postgres answers the second one
       * with `doc ? 'ct'` as a single boolean.
       *
       * The document is only fetched on the path that hands it back, which is a
       * conflict, and by then the row is already locked by this transaction, so
       * the second read cannot see a different one.
       */
      const { rows } = await client.query(
        `SELECT version, updated_at, updated_by, (doc ? 'ct') AS sealed
           FROM budget_document WHERE id = $1 FOR UPDATE`,
        [ROW_ID],
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      const currentVersion = row ? Number(row.version) : 0;

      // A one-way ratchet, checked inside the same locked transaction as the
      // version so it cannot be raced: once a document is sealed, nothing may
      // put a readable one back in its place.
      if (row && row.sealed === true && !isEnvelope(doc)) {
        await client.query("ROLLBACK");
        return { ok: false, wouldDecrypt: true };
      }

      if (!writeAllowed(currentVersion, baseVersion)) {
        let stored: unknown;
        if (row) {
          const { rows: full } = await client.query(
            "SELECT doc FROM budget_document WHERE id = $1",
            [ROW_ID],
          );
          stored = (full[0] as Record<string, unknown> | undefined)?.doc;
        }
        await client.query("ROLLBACK");
        return {
          ok: false,
          conflict: row
            ? {
                version: currentVersion,
                updatedAt: new Date(row.updated_at as string).toISOString(),
                updatedBy: String(row.updated_by),
                doc: stored,
              }
            : undefined,
        };
      }

      const version = currentVersion + 1;
      const updatedAt = new Date().toISOString();

      /**
       * The version about to be replaced, kept before it is.
       *
       * Inside the same transaction as the write, so a crash between the two
       * cannot leave the history with a gap exactly where the accident was.
       * SELECT from the row being replaced rather than from what the caller
       * sent, because what is being preserved is what is stored.
       */
      if (row) {
        await client.query(
          `INSERT INTO budget_history (version, updated_at, updated_by, doc)
           SELECT version, updated_at, updated_by, doc FROM budget_document WHERE id = $1
           ON CONFLICT (version) DO NOTHING`,
          [ROW_ID],
        );
        // Trimmed here rather than on a schedule: this is the only moment a
        // new one arrives, and nothing else runs often enough to be trusted
        // with it.
        await client.query(
          `DELETE FROM budget_history
            WHERE version <= (
              SELECT version FROM budget_history ORDER BY version DESC OFFSET $1 LIMIT 1
            )`,
          [KEEP_VERSIONS],
        );
      }

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
  });
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

const queueTable = onDemandTable(`
  CREATE TABLE IF NOT EXISTS sync_queue (
    id bigserial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    epk text NOT NULL,
    iv text NOT NULL,
    ct text NOT NULL
  )
`);

export async function queuePull(box: { epk: string; iv: string; ct: string }): Promise<number> {
  const { rows } = await queueTable.guard(async () => (await db()).query(
    "INSERT INTO sync_queue (epk, iv, ct) VALUES ($1, $2, $3) RETURNING id",
    [box.epk, box.iv, box.ct],
  ));
  return Number((rows[0] as { id: number }).id);
}

/** Oldest first, so a browser applies overnight pulls in the order they happened. */
export async function readQueue(limit = 50): Promise<QueuedPull[]> {
  const { rows } = await queueTable.guard(async () => (await db()).query(
    "SELECT id, created_at, epk, iv, ct FROM sync_queue ORDER BY id ASC LIMIT $1",
    [limit],
  ));
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    createdAt: new Date(r.created_at as string).toISOString(),
    epk: String(r.epk),
    iv: String(r.iv),
    ct: String(r.ct),
  }));
}

/**
 * How much is waiting, and since when.
 *
 * The diagnosis used to answer this by fetching up to two hundred queued
 * pulls and calling `.length` on them, which on an installation nobody has
 * opened for a month is megabytes of ciphertext dragged out of the database
 * to count rows. Postgres counts rows.
 */
export async function queueStats(): Promise<{ count: number; oldest: string | null }> {
  const { rows } = await queueTable.guard(async () => (await db()).query(
    "SELECT count(*)::int AS n, min(created_at) AS oldest FROM sync_queue",
  ));
  const row = rows[0] as { n: number; oldest: string | null };
  return {
    count: Number(row.n),
    oldest: row.oldest ? new Date(row.oldest).toISOString() : null,
  };
}

/** Dropped only once a browser has merged them in and saved the result. */
export async function clearQueue(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const { rowCount } = await queueTable.guard(async () => (await db()).query(
    "DELETE FROM sync_queue WHERE id = ANY($1::bigint[])",
    [ids],
  ));
  return rowCount ?? 0;
}

/**
 * Stops the queue growing without bound if nobody opens the app for months.
 * A pull older than this is stale anyway — the next one supersedes it.
 */
export async function trimQueue(keepDays = 30): Promise<number> {
  const { rowCount } = await queueTable.guard(async () => (await db()).query(
    "DELETE FROM sync_queue WHERE created_at < now() - ($1 || ' days')::interval",
    [String(keepDays)],
  ));
  return rowCount ?? 0;
}
