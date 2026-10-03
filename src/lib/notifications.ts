import type { Account, DB, ID, ISODate } from "../types.js";
import { budgetSummary, categoryKind, counts, merchantKey, mutedAccountIds, recurringList, spendRun } from "./select.js";
import { integrations, healthOf, staleSince } from "./integrations.js";
import { connectionOf } from "./connection.js";
import type { Connection } from "./connection.js";
import { goalOutlook } from "./goal-funding.js";
import { addDays, monthLabel, sinceLabel, thisMonth, today } from "./date.js";
import { priceChanges } from "./price-watch.js";
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
  | "unusual" | "missing" | "review" | "integration" | "swing" | "price"
  // The two the household sets for itself. See settings.alerts.
  | "nearing" | "balance";

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

/** The rungs in order, so "reached this one or further" is a comparison. */
const TIER_RANK: Record<"over" | "over25" | "over50", number> = { over: 1, over25: 2, over50: 3 };

/**
 * The day a category's spending reached a rung, within its month.
 *
 * This used to be dated to the first of the month and read "September so far",
 * on the reasoning that the document does not say which transaction crossed
 * the line. It does. Walking the month's spending in order and asking
 * `overspendTier` after each day says exactly which day the answer changed,
 * and asking the same function the notice itself is built from is what keeps
 * the date and the rung from ever disagreeing.
 *
 * The *last* crossing rather than the first. A category can go past its plan,
 * be pulled back under by a refund, and go past it again, and the notice is a
 * statement about how things stand now. Dating that to a crossing which was
 * subsequently undone would date a current fact to a day it stopped being
 * true. Where nothing was refunded the two are the same day.
 *
 * Null when the walk cannot find a crossing at all, which should not happen
 * while this and the figures beside it read the same transactions, and which
 * the caller treats as "the month" rather than inventing a day.
 */
export function tierReachedOn(
  run: readonly { date: ISODate; total: number }[],
  planned: number,
  tier: "over" | "over25" | "over50",
): ISODate | null {
  /** Nought for a category still inside its plan, and the rung otherwise. */
  const rankOf = (total: number): number => {
    const reached = overspendTier(planned, total);
    return reached ? TIER_RANK[reached] : 0;
  };

  const want = TIER_RANK[tier];
  let crossed: ISODate | null = null;
  let was = 0;
  for (const point of run) {
    const rank = rankOf(point.total);
    // Up through the rung starts a streak; back down through it ends one. So
    // what is left at the end is the day the streak still running began, or
    // nothing at all if the month finished back inside the plan.
    if (rank >= want && was < want) crossed = point.date;
    else if (rank < want && was >= want) crossed = null;
    was = rank;
  }
  return crossed;
}

/**
 * The day a running total last reached a figure, within its month.
 *
 * The same walk `tierReachedOn` makes, against a figure rather than a rung,
 * for the threshold a household has set for itself. At or past, because a plan
 * of a hundred and a mark of ninety percent is reached at ninety exactly and
 * saying otherwise would be a penny of pedantry nobody asked for.
 */
export function crossedOn(
  run: readonly { date: ISODate; total: number }[],
  atLeast: number,
): ISODate | null {
  let crossed: ISODate | null = null;
  let was = false;
  for (const point of run) {
    const now = point.total >= atLeast;
    if (now && !was) crossed = point.date;
    else if (!now && was) crossed = null;
    was = now;
  }
  return crossed;
}

/**
 * The day an account last fell below a figure.
 *
 * Read off the balance history, which is what the charts draw and so the only
 * answer that will agree with them. The current balance is appended where the
 * history has not caught up with it, because a balance written this morning by
 * a sync is a fact about today whether or not a point was kept for it.
 *
 * Null when the account has never been above the floor in what is recorded: a
 * balance that starts below and stays there did not fall on any day this
 * document can name, and dating it to the first point would invent a day.
 */
export function fellBelowOn(
  account: { history: readonly { date: ISODate; balance: number }[]; balance: number },
  floor: number,
  now: ISODate,
): ISODate | null {
  const points = [...account.history].sort((a, b) => (a.date < b.date ? -1 : 1));
  const last = points[points.length - 1];
  if (!last || last.balance !== account.balance || last.date < now) {
    points.push({ date: now, balance: account.balance });
  }
  let fell: ISODate | null = null;
  let was = false;
  for (const point of points) {
    const under = point.balance < floor;
    if (under && !was) fell = point.date;
    else if (!under && was) fell = null;
    was = under;
  }
  return fell;
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
      due: addDays(seen, span * periods), since: seen,
    });
  }
  return out;
}

const TIER_WORDS: Record<string, string> = {
  over: "over budget",
  over25: "25% over budget",
  over50: "50% over budget",
};

/** Everything worth saying, newest first. */
/* ── a balance that did not so much move as vanish ─────────────────────── */

/**
 * How far a balance has to fall, or climb, before the app says something.
 *
 * A proportion and a floor, because either alone is wrong. A card cleared from
 * three thousand to nothing is a hundred percent and completely ordinary; a
 * brokerage down fifty thousand in a bad week is a lot of money and also
 * ordinary. What is not ordinary is a balance that nearly disappears: a
 * mortgage reported at four hundred and twenty thousand one morning and
 * fourteen hundred the next.
 *
 * Nine tenths, which is deliberately far past anything a market does, and ten
 * thousand dollars, which is deliberately far past a cleared credit card.
 */
export const SWING_SHARE = 0.9;
export const SWING_FLOOR = 10_000_00;
/** Old news is not news. A jump nobody looked at for a fortnight is history. */
export const SWING_DAYS = 14;

export interface Swing {
  accountId: ID;
  name: string;
  from: number;
  to: number;
  at: ISODate;
}

/**
 * Balances that changed by almost all of themselves in one step.
 *
 * Only on accounts a provider writes. A figure somebody typed in is a figure
 * somebody meant, and telling them it surprised you is noise.
 *
 * The comparison is against the previous *recorded* point rather than
 * yesterday, because history is squashed: an account that does not move writes
 * nothing, so the point before a jump can be weeks old and is still the right
 * thing to compare against.
 */
export function balanceSwings(db: DB, now: ISODate = today()): Swing[] {
  const out: Swing[] = [];
  for (const a of db.accounts) {
    if (a.hidden || a.closedAt) continue;
    if (!a.syncSource || a.syncSource === "manual" || a.syncSource === "csv") continue;
    if (a.history.length < 2) continue;

    const last = a.history[a.history.length - 1];
    const prev = a.history[a.history.length - 2];
    if (daysBetween(last.date, now) > SWING_DAYS || last.date > now) continue;

    const before = Math.abs(prev.balance);
    const after = Math.abs(last.balance);
    if (Math.abs(after - before) < SWING_FLOOR) continue;
    // Either direction: the morning it comes back is as worth knowing as the
    // morning it went. Guarded against a previous balance of nothing, where
    // no proportion exists and the floor has already had its say.
    const vanished = before > 0 && after <= before * (1 - SWING_SHARE);
    const appeared = after > 0 && before <= after * (1 - SWING_SHARE);
    if (!vanished && !appeared) continue;

    out.push({ accountId: a.id, name: a.name, from: prev.balance, to: last.balance, at: last.date });
  }
  return out;
}

/** "A and B", "A, B and C" — a list somebody would say out loud. */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Worked out once per document per day.
 *
 * Nothing here is written down when it happens; every notice is read off the
 * document as it stands. Which is the right arrangement and an expensive one:
 * it walks the ledger several times over, and the bell asks for it on every
 * write, so a household renaming a merchant was paying for the whole list on
 * every keystroke. Worse, the open panel asks a second time for the same
 * answer the count was just worked out from.
 *
 * Keyed on the document and the day, because both are what it is a function
 * of. A document is replaced whole on every write, so a cached list cannot
 * outlive the figures behind it, and the day is in the key because half of
 * these are "how long has this been quiet".
 */
const noticeCache = new WeakMap<DB, Map<ISODate, Notice[]>>();

export function notices(db: DB, now: ISODate = today()): Notice[] {
  const byDay = noticeCache.get(db);
  const hit = byDay?.get(now);
  if (hit) return hit;
  const out = buildNotices(db, now);
  if (byDay) byDay.set(now, out);
  else noticeCache.set(db, new Map([[now, out]]));
  return out;
}

function buildNotices(db: DB, now: ISODate): Notice[] {
  const out: Notice[] = [];

  // ── a synced balance that nearly vanished ──
  //
  // First, because it is the only notice here that says a figure the app is
  // showing you may be wrong. Everything else reports something true.
  for (const s of balanceSwings(db, now)) {
    const gone = Math.abs(s.to) < Math.abs(s.from);
    out.push({
      // Dated, so a balance that jumps again later is a new notice rather than
      // one already dismissed.
      id: `swing:${s.accountId}:${s.at}`,
      kind: "swing",
      title: `${s.name} ${gone ? "nearly emptied" : "jumped"}`,
      body: `It went from ${fmt0(s.from)} to ${fmt0(s.to)} in one sync. `
        + `That is usually the provider reporting a different account, not money moving. `
        + `Check it against the institution before trusting your net worth.`,
      at: s.at,
      when: sinceLabel(`${s.at}T12:00:00.000Z`, new Date(`${now}T12:00:00.000Z`)),
      to: `/accounts/${s.accountId}`,
      tone: "warn",
    });
  }

  // ── a subscription that went up without saying so ──
  for (const c of priceChanges(db, now)) {
    if (c.delta <= 0) continue;
    out.push({
      // Dated to the charge, so a second rise next year is its own notice
      // rather than one already read.
      id: `price:${c.id}:${c.at}`,
      kind: "price",
      title: `${c.merchant} went up ${fmt0(c.delta)}`,
      body: `${fmt0(c.was)} to ${fmt0(c.now)}, ${c.share}% more. `
        + `At this cadence that is ${fmt0(c.yearly)} a year.`,
      at: c.at,
      when: sinceLabel(`${c.at}T12:00:00.000Z`, new Date(`${now}T12:00:00.000Z`)),
      to: "/recurring",
      tone: "warn",
    });
  }

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
      // The day it actually went past, worked out from the month's spending
      // rather than filed under the month as a whole. Dated to the first and
      // read as "September so far", this sat at the bottom of a list ordered
      // newest first while being the most current thing in it.
      const went = tierReachedOn(spendRun(db, month, row.category.id), row.planned, tier);
      // Never ahead of today. A transaction dated into next week counts
      // towards the figure, so it can be the one that carries a category past
      // its plan, and dating the notice to it would read "in 4 days" and sit
      // at the top of a newest-first list until the day arrived. As far as
      // anyone using the app is concerned, it is over now.
      const crossed = went && went > now ? now : went;
      out.push({
        id: `budget:${month}:${row.category.id}:${tier}`,
        kind: "budget",
        title: `${row.category.name} is ${TIER_WORDS[tier]}`,
        body: `${fmt0(row.actual)} spent of ${fmt0(row.planned)} planned. `
          + `${fmt0(row.actual - row.planned)} past it.`,
        at: crossed ?? `${month}-01`,
        when: crossed
          ? sinceLabel(`${crossed}T12:00:00.000Z`, new Date(`${now}T12:00:00.000Z`))
          // Only when the walk found no crossing at all, which means the
          // figures and the days behind them have stopped agreeing. Saying
          // "the month" is honest about that; a made-up day would not be.
          : `${monthLabel(month)} so far`,
        to: "/budget",
        tone: "neg",
      });
    }
  }

  // ── the two thresholds the household set for itself ──
  //
  // Everything above fires on a rung this app chose. These only exist if
  // somebody asked for them, and the figure they were asked for is in the id,
  // so moving the mark raises a fresh notice rather than reviving a read one.
  const alerts = db.settings.alerts;
  const budgetAt = alerts?.budgetAt;
  if (budgetAt && budgetAt > 0 && budgetAt < 100) {
    for (const group of budgetSummary(db, month).expense) {
      for (const row of group.rows) {
        if (row.planned <= 0) continue;
        // Already past the plan, which the notice above says more usefully.
        // Two lines about one category is one line too many.
        if (overspendTier(row.planned, row.actual)) continue;
        const mark = Math.round((row.planned * budgetAt) / 100);
        if (row.actual < mark) continue;
        const went = crossedOn(spendRun(db, month, row.category.id), mark);
        const crossed = went && went > now ? now : went;
        out.push({
          id: `nearing:${month}:${row.category.id}:${budgetAt}`,
          kind: "nearing",
          title: `${row.category.name} is ${budgetAt}% through its plan`,
          body: `${fmt0(row.actual)} spent of ${fmt0(row.planned)} planned. `
            + `${fmt0(row.planned - row.actual)} left for the rest of the month.`,
          at: crossed ?? `${month}-01`,
          when: crossed
            ? sinceLabel(`${crossed}T12:00:00.000Z`, new Date(`${now}T12:00:00.000Z`))
            : `${monthLabel(month)} so far`,
          to: "/budget",
          tone: "warn",
        });
      }
    }
  }

  const floor = alerts?.balanceFloor;
  if (floor && floor > 0) {
    for (const account of db.accounts) {
      // Current accounts only, which is what the floor is about: the thing
      // bills come out of. A savings account under the figure is a savings
      // account, not a problem.
      if (account.type !== "checking" || account.hidden || account.closedAt) continue;
      if (account.balance >= floor) continue;
      const fell = fellBelowOn(account, floor, now);
      out.push({
        id: `balance:${account.id}:${floor}:${fell ?? month}`,
        kind: "balance",
        title: `${account.name} is below ${fmt0(floor)}`,
        body: `${fmt0(account.balance)} in it. You asked to be told at ${fmt0(floor)}.`,
        at: fell ?? now,
        when: fell
          ? sinceLabel(`${fell}T12:00:00.000Z`, new Date(`${now}T12:00:00.000Z`))
          : "now",
        to: `/accounts/${account.id}`,
        tone: "neg",
      });
    }
  }

  /**
   * A bank that has stopped answering: one notice per bank, not per account.
   *
   * The trouble belongs to the login rather than to the accounts behind it,
   * and the fix is one press of Reconnect however many there are. A household
   * with a current account, a savings account and two IRAs at one bank got
   * four identical notifications, each carrying the same paragraph of Plaid's,
   * which filled the list and said nothing the first one had not.
   */
  const troubled = new Map<string, { accounts: Account[]; conn: Connection }>();
  for (const account of db.accounts) {
    if (account.hidden || account.closedAt) continue;
    const conn = connectionOf(account, db, Date.parse(now) || Date.now());
    if (conn.state !== "attention") continue;
    // By the bank's name as this document spells it, so two accounts at one
    // bank meet here whether or not they came in through the same connection.
    const key = (account.institution ?? "").trim().toLowerCase() || account.id;
    const held = troubled.get(key);
    // The connection kept is the first one's: every account behind one login
    // reports the same trouble, because the trouble is the login's.
    if (held) held.accounts.push(account);
    else troubled.set(key, { accounts: [account], conn });
  }

  for (const { accounts, conn } of troubled.values()) {
    const bank = accounts[0].institution?.trim() || accounts[0].name;
    const names = accounts.map((a) => a.name);
    out.push({
      // Keyed on the bank rather than on an account, or dismissing it would
      // leave the same notice behind once for every account it covers.
      id: `connection:${bank.toLowerCase()}:${conn.lastAt?.slice(0, 10) ?? "never"}`,
      kind: "connection",
      title: `${bank} needs reconnecting`,
      body: [
        conn.detail ?? conn.status,
        names.length > 1 ? `Affects ${listed(names)}.` : "",
      ].filter(Boolean).join(" "),
      at: conn.lastAt?.slice(0, 10) ?? now,
      when: conn.lastAt ? `last answered ${sinceLabel(conn.lastAt, new Date(`${now}T12:00:00.000Z`))}` : "never connected",
      // One account has a page worth landing on. Several do not share one, and
      // the button that actually fixes this is in Settings either way.
      to: accounts.length === 1 ? `/accounts/${accounts[0].id}` : "/settings",
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
  const at = Date.parse(now) || Date.now();
  for (const row of integrations(db, null, at)) {
    if (!row.set) continue;
    if (row.error) {
      const health = healthOf(row, at);
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
      continue;
    }
    // The quiet failure. Nothing is broken as far as anything can tell, and
    // nothing has happened for a fortnight, which is the shape a scheduled job
    // that stopped being called has. Said once rather than once a day: keyed
    // on the week so it comes back if it goes on being true, and does not
    // arrive every morning in between.
    const resting = staleSince(row, at);
    if (resting) {
      out.push({
        // Keyed on the message, which names the day it last ran, so it is one
        // piece of news rather than the same one every morning.
        id: `integration:${row.id}:quiet:${resting}`,
        kind: "integration",
        title: `${row.provider}: ${resting.toLowerCase()}`,
        body: `${row.process}. Nothing has failed, which is what makes this worth saying: it has simply stopped happening.`,
        at: now,
        when: "now",
        to: "/settings",
        tone: "warn",
      });
      continue;
    }
    // Running, reporting no trouble, and bringing nothing back. The worst of
    // the three, because every other signal says it is fine.
    if (!row.quiet) continue;
    out.push({
      id: `integration:${row.id}:empty:${row.quiet.since}`,
      kind: "integration",
      title: `${row.provider} has brought nothing back since ${row.quiet.since}`,
      body: `${row.process}. It is still running and still reporting no trouble, so nothing else will tell you. `
        + `${row.quiet.days} days with nothing, against a usual gap of ${row.quiet.usual}. `
        + "A login that needs renewing at the bank looks exactly like this.",
      at: now,
      when: "now",
      to: "/settings",
      tone: "warn",
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
