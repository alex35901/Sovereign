/**
 * How many bytes this browser has moved over the sync API this month.
 *
 * Neon's free plan allows five gigabytes of network transfer a month, and this
 * app went through the whole allowance in about a week once — a sync loop that
 * pulled the entire document every few seconds, which nothing in the app said
 * out loud. The fix held, but nothing was watching, and a number nobody can
 * see is a number that surprises you again.
 *
 * Two deliberate choices:
 *
 *   - it counts what crosses this app's own API, not what Neon bills. Neon
 *     meters the traffic between its storage and its compute; this meters the
 *     traffic that causes it. The two are close and neither is the other, so
 *     the reading is labelled as an estimate wherever it is shown.
 *
 *   - it lives in localStorage rather than in the document. Putting it in the
 *     document would mean every poll marked the document dirty, which would
 *     push a write, which would move more bytes — a meter that ran up its own
 *     reading. Per-browser is also the more useful cut: the runaway loop was
 *     one tab's doing.
 */

const KEY = "sovereign.transfer";

export interface Transfer {
  /** The month this total belongs to, YYYY-MM. */
  period: string;
  bytes: number;
  /** Requests counted, which is what makes a runaway loop obvious. */
  calls: number;
}

const monthOf = (now: number): string => new Date(now).toISOString().slice(0, 7);

const empty = (period: string): Transfer => ({ period, bytes: 0, calls: 0 });

/** This month's total, zeroed when the month has rolled over. */
export function transferThisMonth(now: number = Date.now()): Transfer {
  const period = monthOf(now);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty(period);
    const held = JSON.parse(raw) as Partial<Transfer>;
    if (held.period !== period || typeof held.bytes !== "number") return empty(period);
    return { period, bytes: held.bytes, calls: typeof held.calls === "number" ? held.calls : 0 };
  } catch {
    return empty(period);
  }
}

/** Adds one request's worth. Never throws — a full disk must not break a sync. */
export function noteTransfer(bytes: number, now: number = Date.now()): void {
  if (!Number.isFinite(bytes) || bytes < 0) return;
  const cur = transferThisMonth(now);
  try {
    localStorage.setItem(KEY, JSON.stringify({
      period: cur.period,
      bytes: cur.bytes + Math.round(bytes),
      calls: cur.calls + 1,
    }));
  } catch { /* storage full; the next write retries */ }
}

/**
 * What one response cost, near enough.
 *
 * Prefers the header, which is what the server actually sent, and falls back
 * to reading a clone only when the response was chunked and there is no other
 * way to know. Request bodies are added in because a document PUT is by far
 * the largest thing this app sends.
 */
export async function measure(res: Response, sent: BodyInit | null | undefined): Promise<number> {
  let bytes = typeof sent === "string" ? sent.length : 0;
  const header = res.headers.get("content-length");
  if (header !== null && Number.isFinite(Number(header))) return bytes + Number(header);
  try {
    bytes += (await res.clone().text()).length;
  } catch { /* already consumed, or not readable — the header case is the norm */ }
  return bytes;
}

/** Neon's free plan, in bytes. The one that ran out. */
export const MONTHLY_TRANSFER = 5 * 1024 * 1024 * 1024;

export const asMB = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 10) / 10;
