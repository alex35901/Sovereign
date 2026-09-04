import type { DB, ISODate } from "../types.js";

/**
 * Keeping balance history to the points that carry information.
 *
 * Every sync writes one balance point per account per day, and a balance that
 * has not moved writes the same figure again — a paid-off car, a stable-value
 * fund, an account nobody touches. Charts forward-fill from the last point at
 * or before a date, so a repeated figure changes nothing anyone can see and
 * costs bytes in a document that is uploaded whole on every save.
 *
 * Lossless, not lossy: `balanceAt` returns the latest point at or before the
 * date it is asked about, so removing a point that repeats the one before it
 * cannot change any answer. The first is kept because it pins where the record
 * starts, and the last because it is when the figure was last actually seen.
 */

export interface Point { date: ISODate; balance: number }

/** First, every change, and last. */
export function compressPoints(points: readonly Point[]): Point[] {
  if (points.length < 3) return [...points];
  const out: Point[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    if (points[i]!.balance !== out[out.length - 1]!.balance) out.push(points[i]!);
  }
  out.push(points[points.length - 1]!);
  return out;
}

export interface Squashed {
  db: DB;
  /** Points dropped, across every account. */
  removed: number;
  /** Bytes the document loses by dropping them. */
  saved: number;
}

/**
 * Squashes every account's history, and says what it cost the document.
 *
 * Measured rather than estimated — the saving is the difference between the
 * two serialised forms, which is exactly what a save would have carried.
 */
export function squashHistory(db: DB): Squashed {
  let removed = 0;
  const accounts = db.accounts.map((a) => {
    const next = compressPoints(a.history);
    if (next.length === a.history.length) return a;
    removed += a.history.length - next.length;
    return { ...a, history: next };
  });
  if (!removed) return { db, removed: 0, saved: 0 };

  const before = JSON.stringify(db.accounts).length;
  const after = JSON.stringify(accounts).length;
  return { db: { ...db, accounts }, removed, saved: Math.max(0, before - after) };
}
