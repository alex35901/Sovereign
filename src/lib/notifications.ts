import type { DB, ISODate } from "../types.js";
import { budgetSummary, recurringList } from "./select.js";
import { connectionOf } from "./connection.js";
import { goalOutlook } from "./goal-funding.js";
import { monthLabel, sinceLabel, thisMonth, today } from "./date.js";
import { fmt0 } from "./money.js";

/**
 * What the app would tell you if you had not been looking.
 *
 * Every notice is worked out from the document as it stands, not written down
 * when it happens. Nothing here runs on a schedule or needs to have been
 * running: a budget that went past its plan while the browser was shut is past
 * it the moment anyone opens the app, and a notice recorded at the time would
 * be a second copy of a fact the figures already hold.
 *
 * What *is* stored is the other half — which notices have been read. So the
 * id has to say precisely what was true, not merely what it was about:
 * `budget:2026-09:c_groceries:over25` is a different fact from `:over`, and
 * reading the first must not silence the second. Spending further past a plan
 * raises a new notice rather than reviving a dismissed one.
 */

export type NoticeKind = "recurring" | "budget" | "connection" | "goal";

export interface Notice {
  /** Stable, and specific to what was true. See above. */
  id: string;
  kind: NoticeKind;
  title: string;
  body: string;
  /** The day this became true, as best the document can say. */
  at: ISODate;
  /**
   * How to say `at` out loud.
   *
   * Carried rather than derived at the point of display, because the two kinds
   * of date here are not the same kind of fact. A subscription was spotted on
   * a day, and "3 days ago" is the useful reading of that. A category is over
   * its plan *for a month*, and dating that to the 1st and printing "6 days
   * ago" would put an event on something that is simply the state of
   * September.
   */
  when: string;
  /** Where to go to do something about it. */
  to?: string;
  tone: "neg" | "pos" | "warn";
}

/** How recently a pattern must have completed to still count as news. */
export const RECURRING_NEW_DAYS = 30;

/** How many read marks are kept before the oldest are dropped. */
export const SEEN_CAP = 400;

const daysBetween = (a: ISODate, b: ISODate): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * A newly detected recurring item is news; one that has been running for a
 * year is not.
 *
 * Judged on when the pattern completed rather than on when it was noticed,
 * because detection is recomputed from the transactions on every render —
 * "when it was noticed" is always now, and by that measure nothing would ever
 * stop being new.
 */
export function isNewRecurring(r: { detected: boolean; detectedAt?: ISODate }, now: ISODate = today()): boolean {
  if (!r.detected || !r.detectedAt) return false;
  const age = daysBetween(r.detectedAt, now);
  return age >= 0 && age <= RECURRING_NEW_DAYS;
}

/** Whether a notice has been read. */
export const isSeen = (db: DB, id: string): boolean => Boolean(db.settings.seenNotices?.[id]);

/**
 * How far past its plan a category has gone, as a rung rather than a number.
 *
 * Three rungs, so a category that creeps past its plan says so once, and only
 * speaks again when it has gone meaningfully further. Reporting the percentage
 * itself would be a new notice on every transaction.
 */
export function overspendTier(planned: number, actual: number): "over" | "over25" | "over50" | null {
  if (planned <= 0 || actual <= planned) return null;
  const share = (actual - planned) / planned;
  if (share >= 0.5) return "over50";
  if (share >= 0.25) return "over25";
  return "over";
}

const TIER_WORDS: Record<string, string> = {
  over: "over budget",
  over25: "25% over budget",
  over50: "50% over budget",
};

/** Everything worth saying, newest first. */
export function notices(db: DB, now: ISODate = today()): Notice[] {
  const out: Notice[] = [];

  // ── a subscription that has just shown its third charge ──
  for (const r of recurringList(db)) {
    if (!isNewRecurring(r, now)) continue;
    out.push({
      id: `recurring:${r.id}`,
      kind: "recurring",
      title: `${r.merchant} looks recurring`,
      body: `${fmt0(Math.abs(r.amount))} ${r.cadence === "monthly" ? "a month" : r.cadence}, `
        + `spotted from your history. Check the amount and the date, or say it isn't.`,
      at: r.detectedAt!,
      when: sinceLabel(`${r.detectedAt!}T12:00:00.000Z`, new Date(`${now}T12:00:00.000Z`)),
      to: "/recurring",
      tone: r.amount > 0 ? "pos" : "warn",
    });
  }

  // ── a category past its plan, at whichever rung it has reached ──
  const month = thisMonth();
  for (const group of budgetSummary(db, month).expense) {
    for (const row of group.rows) {
      const tier = overspendTier(row.planned, row.actual);
      if (!tier) continue;
      out.push({
        id: `budget:${month}:${row.category.id}:${tier}`,
        kind: "budget",
        title: `${row.category.name} is ${TIER_WORDS[tier]}`,
        body: `${fmt0(row.actual)} spent of ${fmt0(row.planned)} planned — `
          + `${fmt0(row.actual - row.planned)} past it.`,
        // Dated to the month rather than to a day: the document does not say
        // which transaction crossed the line, and guessing at one would put a
        // date on this that nothing else agrees with.
        at: `${month}-01`,
        when: `${monthLabel(month)} so far`,
        to: "/budget",
        tone: "neg",
      });
    }
  }

  // ── a bank that has stopped answering ──
  for (const account of db.accounts) {
    if (account.hidden || account.closedAt) continue;
    const conn = connectionOf(account, db, Date.parse(now) || Date.now());
    if (conn.state !== "attention") continue;
    out.push({
      id: `connection:${account.id}:${conn.lastAt?.slice(0, 10) ?? "never"}`,
      kind: "connection",
      title: `${account.name} needs reconnecting`,
      body: conn.detail ?? conn.status,
      at: conn.lastAt?.slice(0, 10) ?? now,
      when: conn.lastAt ? `last answered ${sinceLabel(conn.lastAt, new Date(`${now}T12:00:00.000Z`))}` : "never connected",
      to: `/accounts/${account.id}`,
      tone: "neg",
    });
  }

  // ── a goal that has got there ──
  for (const goal of db.goals) {
    if (goal.archived) continue;
    const outlook = goalOutlook(db, goal.id);
    if (outlook.status !== "reached" || outlook.target <= 0) continue;
    out.push({
      id: `goal:${goal.id}:reached`,
      kind: "goal",
      title: `${goal.name} is fully funded`,
      body: `${fmt0(outlook.saved)} of ${fmt0(outlook.target)}. Time to spend it, or raise the target.`,
      at: now,
      when: "now",
      to: `/goals/${goal.id}`,
      tone: "pos",
    });
  }

  return out.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? 1 : -1));
}

/** The ones nobody has read yet. */
export const unread = (db: DB, now?: ISODate): Notice[] =>
  notices(db, now).filter((n) => !isSeen(db, n.id));

/**
 * Marks notices read, and forgets the oldest marks once there are too many.
 *
 * Bounded for the same reason everything else in the document is: it is
 * uploaded whole on every save. A mark that falls off the end can only bring
 * back a notice whose subject is still true, which is a far smaller cost than
 * a map that grows for ever.
 */
export function markRead(db: DB, ids: readonly string[], now: string = new Date().toISOString()): DB {
  if (!ids.length) return db;
  const seen: Record<string, string> = { ...(db.settings.seenNotices ?? {}) };
  for (const id of ids) seen[id] = now;

  const keys = Object.keys(seen);
  if (keys.length > SEEN_CAP) {
    const oldest = keys.sort((a, b) => (seen[a]! < seen[b]! ? -1 : 1));
    for (const id of oldest.slice(0, keys.length - SEEN_CAP)) delete seen[id];
  }
  return { ...db, settings: { ...db.settings, seenNotices: seen } };
}
