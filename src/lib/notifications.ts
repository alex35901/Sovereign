import type { DB, ISODate } from "../types.js";
import { budgetSummary, categoryKind, counts, merchantKey, mutedAccountIds, recurringList } from "./select.js";
import { integrations, healthOf } from "./integrations.js";
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

export type NoticeKind =
  | "recurring" | "budget" | "connection" | "goal"
  | "unusual" | "missing" | "review" | "integration";

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

/**
 * How far along a goal is, as a rung.
 *
 * Three of them, because a goal is worth mentioning when it passes a mark
 * somebody would recognise and not on the way between. Reaching it is its own
 * rung and its own tone: the app has nothing useful to say about what to do
 * with the money, and saying it anyway would turn a good moment into advice.
 */
export function goalTier(saved: number, target: number): "half" | "most" | "reached" | null {
  if (target <= 0 || saved <= 0) return null;
  const share = saved / target;
  if (share >= 1) return "reached";
  if (share >= 0.75) return "most";
  if (share >= 0.5) return "half";
  return null;
}

/**
 * Unreviewed transactions, as a rung rather than a running count.
 *
 * A number that ticks up would be a new notice every import; the rungs are
 * spaced so that passing one means the pile has genuinely grown.
 */
export const REVIEW_RUNGS = [25, 50, 100, 250, 500] as const;

export function reviewTier(count: number): number | null {
  let hit: number | null = null;
  for (const rung of REVIEW_RUNGS) if (count >= rung) hit = rung;
  return hit;
}

/**
 * How far past its own usual a charge has to be before it is worth a word.
 *
 * Three times, and at least fifty dollars clear of it. The multiple alone
 * would flag a coffee that cost six pounds instead of two, which is not news
 * about anybody's money.
 */
export const UNUSUAL_MULTIPLE = 3;
export const UNUSUAL_FLOOR = 50_00;

/** How recently a charge must have landed to still be worth remarking on. */
export const UNUSUAL_DAYS = 30;

/** Charges enough short of their merchant's usual to be worth a second look. */
export interface Unusual { id: string; merchant: string; amount: number; typical: number; date: ISODate }

export function unusualCharges(db: DB, now: ISODate = today()): Unusual[] {
  const muted = mutedAccountIds(db);
  const byMerchant = new Map<string, { name: string; amounts: number[] }>();
  for (const t of db.transactions) {
    if (!counts(t, muted) || t.amount >= 0) continue;
    if (categoryKind(db, t.categoryId) === "transfer") continue;
    const key = merchantKey(t.merchant);
    if (!key) continue;
    const at = byMerchant.get(key) ?? { name: t.merchant, amounts: [] };
    at.amounts.push(Math.abs(t.amount));
    byMerchant.set(key, at);
  }

  const out: Unusual[] = [];
  for (const t of db.transactions) {
    if (!counts(t, muted) || t.amount >= 0) continue;
    if (categoryKind(db, t.categoryId) === "transfer") continue;
    if (daysBetween(t.date, now) > UNUSUAL_DAYS || t.date > now) continue;
    const at = byMerchant.get(merchantKey(t.merchant));
    // Four charges is the fewest that can establish a usual: with three, one
    // outlier is a third of the evidence for what normal looks like.
    if (!at || at.amounts.length < 4) continue;
    const sorted = [...at.amounts].sort((a, b) => a - b);
    const typical = sorted[Math.floor(sorted.length / 2)]!;
    const amount = Math.abs(t.amount);
    if (typical <= 0) continue;
    if (amount < typical * UNUSUAL_MULTIPLE || amount - typical < UNUSUAL_FLOOR) continue;
    out.push({ id: t.id, merchant: t.merchant, amount, typical, date: t.date });
  }
  return out;
}

/**
 * A recurring charge that has not turned up.
 *
 * Silence is the one thing a list of transactions cannot show you: a
 * subscription that was cancelled, a direct debit that bounced and a sync that
 * quietly stopped all look identical, which is nothing at all. Measured from
 * the last charge that actually landed rather than from the schedule's own
 * next date, because that date is projected forward past today and so is never
 * late by construction.
 */
export interface Overdue { id: string; merchant: string; amount: number; due: ISODate; since: ISODate }

const CADENCE_DAYS: Record<string, number> = {
  weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, semiannual: 182, yearly: 365,
};

export function overdueRecurring(db: DB, now: ISODate = today()): Overdue[] {
  const muted = mutedAccountIds(db);
  const last = new Map<string, ISODate>();
  for (const t of db.transactions) {
    if (!counts(t, muted)) continue;
    const key = merchantKey(t.merchant);
    const at = last.get(key);
    if (!at || t.date > at) last.set(key, t.date);
  }

  const out: Overdue[] = [];
  for (const r of recurringList(db)) {
    const seen = last.get(merchantKey(r.merchant));
    if (!seen) continue;
    const span = CADENCE_DAYS[r.cadence] ?? 30;
    // A grace period, because a bill lands on a working day rather than on the
    // day the arithmetic says. Five days on a weekly one, a fortnight on a
    // yearly one.
    const grace = Math.max(5, Math.round(span * 0.2));
    const gap = daysBetween(seen, now);
    if (gap - span <= grace) continue;
    // Which expected date has most recently gone by, rather than the first one
    // missed. Two months of silence is worse news than one, and an id pinned to
    // the first absence would go on being the same notice somebody has already
    // read while the thing gets steadily worse.
    const periods = Math.floor(gap / span);
    out.push({
      id: r.id, merchant: r.merchant, amount: r.amount,
      due: addDaysISO(seen, span * periods), since: seen,
    });
  }
  return out;
}

const addDaysISO = (d: ISODate, n: number): ISODate =>
  new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

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
        body: `${fmt0(row.actual)} spent of ${fmt0(row.planned)} planned. `
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

  // ── a goal passing a mark somebody would recognise ──
  for (const goal of db.goals) {
    if (goal.archived) continue;
    const outlook = goalOutlook(db, goal.id);
    const tier = goalTier(outlook.saved, outlook.target);
    if (!tier) continue;
    const share = Math.round((outlook.saved / outlook.target) * 100);
    out.push({
      id: `goal:${goal.id}:${tier}`,
      kind: "goal",
      title: tier === "reached"
        ? `${goal.name} is fully funded. Nice work.`
        : `${goal.name} is ${share}% funded`,
      body: tier === "reached"
        ? `${fmt0(outlook.saved)} of ${fmt0(outlook.target)}, all of it saved.`
        : `${fmt0(outlook.saved)} of ${fmt0(outlook.target)}. ${fmt0(outlook.remaining)} to go.`,
      at: now,
      when: "now",
      to: `/goals/${goal.id}`,
      tone: "pos",
    });
  }

  // ── a charge well past what that merchant usually costs ──
  for (const u of unusualCharges(db, now)) {
    out.push({
      id: `unusual:${u.id}`,
      kind: "unusual",
      title: `${u.merchant} charged ${fmt0(u.amount)}`,
      body: `Usually about ${fmt0(u.typical)}. Worth a look if you were not expecting it.`,
      at: u.date,
      when: sinceLabel(`${u.date}T12:00:00.000Z`, new Date(`${now}T12:00:00.000Z`)),
      to: "/transactions",
      tone: "warn",
    });
  }

  // ── something that should have arrived and has not ──
  for (const o of overdueRecurring(db, now)) {
    const income = o.amount > 0;
    out.push({
      // The due date is in the id, so next month's absence is a fresh notice
      // rather than the same one going unread for ever.
      id: `missing:${o.id}:${o.due}`,
      kind: "missing",
      title: income ? `${o.merchant} has not paid` : `${o.merchant} has not charged`,
      body: income
        ? `Expected around ${o.due}, and nothing has landed since ${o.since}.`
        : `Expected around ${o.due}, and nothing has landed since ${o.since}. `
          + `Either it stopped, or the account behind it has.`,
      at: o.due,
      when: sinceLabel(`${o.due}T12:00:00.000Z`, new Date(`${now}T12:00:00.000Z`)),
      to: "/recurring",
      tone: income ? "neg" : "warn",
    });
  }

  // ── a pile of transactions nobody has looked at ──
  const unreviewed = db.transactions.filter((t) => !t.reviewed).length;
  const rung = reviewTier(unreviewed);
  if (rung) {
    out.push({
      id: `review:${rung}`,
      kind: "review",
      title: `${unreviewed} transactions need a category`,
      body: "Categorising them is what makes the budget and the reports mean anything.",
      at: now,
      when: "now",
      to: "/transactions",
      tone: "warn",
    });
  }

  // ── a provider that has stopped working, quietly ──
  for (const row of integrations(db, null, Date.parse(now) || Date.now())) {
    if (!row.set || !row.error) continue;
    const health = healthOf(row);
    if (health.state !== "down") continue;
    out.push({
      // Keyed on the message: a different failure is different news, and the
      // same one going on being true is not.
      id: `integration:${row.id}:${row.error.slice(0, 60)}`,
      kind: "integration",
      title: `${row.provider} is failing`,
      body: `${row.process}. ${row.error}`,
      at: now,
      when: "now",
      to: "/settings",
      tone: "neg",
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
