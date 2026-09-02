import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { db } from "./_store.js";

/**
 * A limit on how fast the passphrase can be guessed.
 *
 * Without one, a constant-time comparison only means nobody can read the
 * passphrase off the response *time* — they can still try every passphrase
 * there is, as fast as the platform will answer, for ever. This makes the
 * eighth wrong answer in a quarter of an hour cost fifteen minutes, and each
 * lockout after that cost more.
 *
 * Counted per caller rather than globally on purpose. A single global counter
 * would let anyone who knows the URL lock the household out by spraying wrong
 * answers at it, which trades one denial of service for another. The cost of
 * that choice is that an attacker spread across many addresses is not slowed
 * down, and the answer to *that* is passphrase length: at HTTP speeds even an
 * unthrottled attack gets nowhere against a long one.
 *
 * State lives in Postgres because a serverless function keeps nothing between
 * invocations — a counter in memory would reset on every cold start, which is
 * to say roughly whenever an attacker waited a moment between guesses.
 */

export const WINDOW_MS = 15 * 60_000;
/** Wrong answers allowed inside one window before the door shuts. */
export const MAX_FAILURES = 8;
/** How long each successive lockout lasts: 15 minutes, an hour, six, a day. */
export const LOCKOUT_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

export interface Attempt {
  failures: number;
  /** How many times this caller has already been locked out. */
  lockouts: number;
  windowStart: number;
  lockedUntil: number | null;
}

export const freshAttempt = (now: number): Attempt => ({
  failures: 0, lockouts: 0, windowStart: now, lockedUntil: null,
});

/**
 * Seconds this caller must wait, or 0 if they may try now.
 *
 * Rounded up, so a caller told to wait n seconds and waiting exactly n is
 * actually let through rather than being told to wait again.
 */
export function lockedFor(attempt: Attempt | null, now: number): number {
  if (!attempt?.lockedUntil || now >= attempt.lockedUntil) return 0;
  return Math.ceil((attempt.lockedUntil - now) / 1000);
}

/**
 * The state after one more wrong answer.
 *
 * A window that has gone stale without reaching the limit starts over, so a
 * wrong password on Tuesday doesn't count against one on Friday. Reaching the
 * limit locks the caller out and opens a fresh window behind the lock, so the
 * guesses that led to it aren't also spent against the next one.
 */
export function afterFailure(attempt: Attempt | null, now: number): Attempt {
  const base = attempt ?? freshAttempt(now);
  const stale = now - base.windowStart > WINDOW_MS;
  const failures = (stale ? 0 : base.failures) + 1;
  const windowStart = stale ? now : base.windowStart;

  if (failures < MAX_FAILURES) return { ...base, failures, windowStart };

  const wait = LOCKOUT_MS[Math.min(base.lockouts, LOCKOUT_MS.length - 1)];
  return { failures: 0, lockouts: base.lockouts + 1, windowStart: now, lockedUntil: now + wait };
}

/**
 * Which caller this is.
 *
 * Vercel sets both of these itself and overwrites anything the client sent, so
 * they cannot be forged from outside. Hashed rather than stored: equality is
 * the only thing this needs, and an address is worth no more than that. Callers
 * arriving with no address at all share one bucket, which errs towards
 * limiting them together rather than not at all.
 */
export function callerKey(scope: string, headers: IncomingHttpHeaders): string {
  const first = (v: string | string[] | undefined): string => {
    const raw = Array.isArray(v) ? v[0] : v;
    return (raw ?? "").split(",")[0]!.trim();
  };
  const ip = first(headers["x-real-ip"]) || first(headers["x-forwarded-for"]) || "unknown";
  return `${scope}:${createHash("sha256").update(ip).digest("hex").slice(0, 32)}`;
}

/** Idempotent, so a database that has never seen this table just works. */
async function ensureTable(): Promise<void> {
  await (await db()).query(`
    CREATE TABLE IF NOT EXISTS auth_attempt (
      id text PRIMARY KEY,
      failures integer NOT NULL DEFAULT 0,
      lockouts integer NOT NULL DEFAULT 0,
      window_start timestamptz NOT NULL,
      locked_until timestamptz
    )
  `);
}

const toAttempt = (row: Record<string, unknown> | undefined): Attempt | null => row
  ? {
      failures: Number(row.failures),
      lockouts: Number(row.lockouts),
      windowStart: new Date(row.window_start as string).getTime(),
      lockedUntil: row.locked_until ? new Date(row.locked_until as string).getTime() : null,
    }
  : null;

export async function readAttempt(key: string): Promise<Attempt | null> {
  await ensureTable();
  const { rows } = await (await db()).query(
    "SELECT failures, lockouts, window_start, locked_until FROM auth_attempt WHERE id = $1",
    [key],
  );
  return toAttempt(rows[0] as Record<string, unknown> | undefined);
}

/** Records a wrong answer and returns how long the caller must now wait. */
export async function noteFailure(key: string, now: number = Date.now()): Promise<number> {
  const next = afterFailure(await readAttempt(key), now);
  await (await db()).query(
    `INSERT INTO auth_attempt (id, failures, lockouts, window_start, locked_until)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5)
     ON CONFLICT (id) DO UPDATE SET
       failures = EXCLUDED.failures,
       lockouts = EXCLUDED.lockouts,
       window_start = EXCLUDED.window_start,
       locked_until = EXCLUDED.locked_until`,
    [key, next.failures, next.lockouts, next.windowStart,
      next.lockedUntil === null ? null : new Date(next.lockedUntil).toISOString()],
  );
  return lockedFor(next, now);
}

/** The right passphrase wipes the slate, so an honest typo costs nothing later. */
export async function clearFailures(key: string): Promise<void> {
  await ensureTable();
  await (await db()).query("DELETE FROM auth_attempt WHERE id = $1", [key]);
}

/** How many callers are currently locked out, for the diagnostics to report. */
export async function lockedOutNow(now: number = Date.now()): Promise<number> {
  await ensureTable();
  const { rows } = await (await db()).query(
    "SELECT count(*)::int AS n FROM auth_attempt WHERE locked_until > to_timestamp($1 / 1000.0)",
    [now],
  );
  return Number((rows[0] as { n: number }).n);
}

/** "Too many attempts. Try again in 14 minutes." */
export function waitMessage(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.ceil(seconds / 3600);
    return `Too many wrong passphrases. Try again in ${hours} hour${hours === 1 ? "" : "s"}.`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `Too many wrong passphrases. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
