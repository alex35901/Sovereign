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
/**
 * How many unchanged asks in a row mean the backfill has stopped.
 *
 * Half a minute of a steady count, at the poll above. Plaid delivers the older
 * months in chunks with pauses between them, and a shorter quiet window reads
 * a pause as the end: the history gets truncated at whatever had arrived, and
 * nothing ever says so.
 */
export const SETTLE_POLLS = 5;
/**
 * How long to wait for the first sign of anything before giving up.
 *
 * A backfill that is going to happen starts producing well inside this. A
 * count that has not moved by now is a bank that has nothing more to send,
 * and spending the full budget on it is four minutes of a spinner ending in
 * the same answer ninety seconds would have given.
 */
export const PATIENCE_MS = 90_000;
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
export function observe(prev: Watch, total: number, settlePolls: number = SETTLE_POLLS): Watch {
  const grew = prev.grew || total > prev.baseline;
  const settled = grew && total === prev.total ? prev.settled + 1 : 0;
  return { baseline: prev.baseline, total, grew, settled, done: grew && settled >= settlePolls };
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
    patienceMs?: number;
    settlePolls?: number;
  } = {},
): Promise<HistoryWait> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? POLL_MS;
  const started = now();
  const until = started + (opts.budgetMs ?? MAX_WAIT_MS);
  const patience = opts.patienceMs ?? PATIENCE_MS;
  /** The full budget is for a backfill that has shown itself. */
  const deadline = () => (watch.grew ? until : Math.min(until, started + patience));

  let watch = startWatch(await probe());
  opts.onProgress?.(watch.total);

  while (!watch.done && now() < deadline()) {
    await sleep(Math.min(pollMs, Math.max(0, deadline() - now())));
    let seen: number;
    try {
      seen = await probe();
    } catch {
      // A probe that failed is not a backfill that failed. Plaid rate-limits,
      // and a wait that gives up at the first refusal gives up on the point of
      // waiting. The budget is what ends this, not one bad answer.
      continue;
    }
    watch = observe(watch, seen, opts.settlePolls);
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

/** What Plaid says it holds for one item. See api/_plaid reportItem. */
export interface ItemReach {
  total: number;
  notReady: boolean;
  oldest?: string;
  newest?: string;
  consented: string[];
  products: string[];
  billed: string[];
  lastUpdate?: string;
}

/**
 * What Plaid holds, in a sentence, and whether that is as shallow as the
 * default.
 *
 * The distinction this draws is the one the app was getting wrong. A window
 * that comes back short can mean the backfill is still running or it can mean
 * there is nothing more to come, and saying "still fetching" about the second
 * leaves somebody pressing a button for ever against a bank that already sent
 * everything it had.
 */
export function describeReach(
  reach: ItemReach,
  institution: string,
  now: number = Date.now(),
): { line: string; detail: string; short: boolean } {
  const detail = [
    reach.consented.length ? `Consented: ${reach.consented.join(", ")}.` : "",
    reach.billed.length ? `Billed: ${reach.billed.join(", ")}.` : "",
    reach.lastUpdate ? `Last transactions update ${reach.lastUpdate.slice(0, 16).replace("T", " ")}.` : "",
  ].filter(Boolean).join(" ");

  if (reach.notReady) {
    return { line: `Plaid is still preparing ${institution}. Press Full history again in a minute.`, detail, short: false };
  }

  // An item that never agreed to hand over transactions has none, and no
  // amount of waiting changes that. It is a different button that fixes it.
  const refused = reach.consented.length > 0 && !reach.consented.includes("transactions");
  if (!reach.total) {
    return {
      line: refused
        ? `Plaid holds no transactions for ${institution}: this connection never agreed to hand them over. Reconnect it and tick transactions when the bank asks.`
        : `Plaid holds no transactions at all for ${institution} over the last two years.`,
      detail,
      short: true,
    };
  }

  const days = reach.oldest ? Math.round((now - Date.parse(`${reach.oldest}T00:00:00Z`)) / 86400000) : 0;
  const months = Math.max(1, Math.round(days / 30.4));
  const short = days < DEFAULT_REACH_DAYS + REACH_MARGIN_DAYS;
  const held = `Plaid holds ${reach.total.toLocaleString()} transaction${reach.total === 1 ? "" : "s"} for `
    + `${institution}, back to ${reach.oldest} (about ${months} month${months === 1 ? "" : "s"})`;

  return {
    line: short
      ? `${held}. That is Plaid's default reach, so the request for two years has not taken effect: `
        + "either this bank serves no more than 90 days through Plaid, or this connection has to be "
        + "remade rather than reconnected."
      : `${held}.`,
    detail,
    short,
  };
}
