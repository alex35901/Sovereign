import type { DB } from "../../types.js";

/**
 * Waiting for Plaid to finish fetching the years it has just been asked for.
 *
 * Raising an item's reach does not hand back the older months: Plaid goes and
 * gets them in the background, over a minute or several, and until it has,
 * every pull returns the ninety days it already held. The first version of
 * Full history left that gap to the person pressing the button, who had to
 * come back later and press it again with no way of knowing when later was.
 *
 * So the app waits instead, and the thing it watches is how many transactions
 * Plaid says are in the window. That figure climbs while the backfill runs and
 * stops when it is done, which is a plain answer to "is it finished" that
 * needs no webhook and no guessing.
 */

/**
 * How long between asks while Plaid fills in the older months.
 *
 * Plaid rate-limits /transactions/get per item per minute, and a wait that
 * trips that limit is a wait that spends its budget being refused. Ten asks a
 * minute leaves room, and the backfill takes minutes rather than seconds, so
 * asking faster would buy nothing anyway.
 */
export const POLL_MS = 6_000;
/** How long to wait in total before handing back whatever has arrived. */
export const MAX_WAIT_MS = 4 * 60_000;
/** How many unchanged asks in a row mean the backfill has stopped. */
export const SETTLE_POLLS = 2;
/** How far back Plaid reaches when it has not been told otherwise. */
export const DEFAULT_REACH_DAYS = 90;
/**
 * Slack on that figure before older rows count as proof of a longer reach.
 * Plaid's ninety days is ninety days of history, not ninety days of calendar,
 * and a window that starts on a weekend is not evidence of anything.
 */
export const REACH_MARGIN_DAYS = 30;

export interface Watch {
  /** What Plaid held when the wait started. */
  baseline: number;
  total: number;
  /** Whether anything has arrived since. */
  grew: boolean;
  /** Consecutive asks that came back with the same figure, once it grew. */
  settled: number;
  done: boolean;
}

export const startWatch = (baseline: number): Watch =>
  ({ baseline, total: baseline, grew: false, settled: 0, done: false });

/**
 * One more reading, folded in.
 *
 * Settling is counted only after something has arrived, because a backfill
 * that has not started yet also reports the same figure twice in a row, and
 * stopping there is stopping before it began.
 */
export function observe(prev: Watch, total: number): Watch {
  const grew = prev.grew || total > prev.baseline;
  const settled = grew && total === prev.total ? prev.settled + 1 : 0;
  return { baseline: prev.baseline, total, grew, settled, done: grew && settled >= SETTLE_POLLS };
}

export interface HistoryWait {
  total: number;
  /** Whether anything older arrived at all. */
  grew: boolean;
  /** Whether the budget ran out with the backfill still going. */
  timedOut: boolean;
}

/**
 * Polls until the figure stops climbing, or the budget runs out.
 *
 * The clock and the sleep are arguments so the policy can be tested without
 * spending four real minutes proving it waits four minutes.
 */
export async function waitForHistory(
  probe: () => Promise<number>,
  opts: {
    onProgress?: (total: number) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    budgetMs?: number;
    pollMs?: number;
  } = {},
): Promise<HistoryWait> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? POLL_MS;
  const until = now() + (opts.budgetMs ?? MAX_WAIT_MS);

  let watch = startWatch(await probe());
  opts.onProgress?.(watch.total);

  while (!watch.done && now() < until) {
    await sleep(Math.min(pollMs, Math.max(0, until - now())));
    let seen: number;
    try {
      seen = await probe();
    } catch {
      // A probe that failed is not a backfill that failed. Plaid rate-limits,
      // and a wait that gives up at the first refusal gives up on the point of
      // waiting. The budget is what ends this, not one bad answer.
      continue;
    }
    watch = observe(watch, seen);
    opts.onProgress?.(watch.total);
  }

  return { total: watch.total, grew: watch.grew, timedOut: !watch.done };
}

/**
 * Whether this item's accounts already hold Plaid rows from further back than
 * Plaid reaches by default.
 *
 * An item raised to two years before the app started remembering that it had
 * would otherwise be sent through the Link dialog one more time for nothing.
 * The evidence is already in the document: a row Plaid filed from before its
 * own default reach can only have come from an item that reaches further.
 *
 * Only rows Plaid filed. History imported from a CSV is older, and says
 * nothing whatever about what the connection can fetch.
 */
export function historyAlreadyDeep(
  db: DB,
  item: { institution: string },
  now: number = Date.now(),
): boolean {
  const mine = new Set(
    db.accounts
      .filter((a) => a.syncSource === "plaid" && a.institution === item.institution)
      .map((a) => a.id),
  );
  if (!mine.size) return false;
  const before = new Date(now - (DEFAULT_REACH_DAYS + REACH_MARGIN_DAYS) * 86400000).toISOString().slice(0, 10);
  return db.transactions.some((t) => t.importKey?.startsWith("pl:") && mine.has(t.accountId) && t.date < before);
}

/**
 * Whether this item still has to go through the Link dialog before it can be
 * asked for a longer history.
 *
 * The answer this exists to make "no" as often as possible. Raising an item's
 * reach is a bank sign-in, and being asked for one on every press of Full
 * history is the button failing at the only thing it is for.
 */
export function needsRaising(
  db: DB,
  item: { kind: "bank" | "investment"; institution: string; historyDays?: number },
  want: number,
  now: number = Date.now(),
): boolean {
  // An investments item has no transactions to reach back through.
  if (item.kind !== "bank") return false;
  // Raised already, and remembered.
  if ((item.historyDays ?? 0) >= want) return false;
  // Raised already, before the app kept a note of it.
  return !historyAlreadyDeep(db, item, now);
}
