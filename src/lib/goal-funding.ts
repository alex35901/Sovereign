import type { Account, DB, Goal, ID, ISODate } from "../types.js";
import { balanceAt } from "./select.js";

/**
 * Which real money is behind each goal.
 *
 * A goal used to name accounts and count all of them, which made two things
 * impossible. An account could not be shared — a joint savings backing an
 * emergency fund, a kitchen and a boat counted three times over — and money
 * arriving in an account was silently absorbed rather than shown as something
 * to decide about.
 *
 * So the balance of a goal account is divided rather than claimed. Every goal
 * holds an amount against each account, the total across goals can never pass
 * what is actually there, and whatever is left is the figure worth looking at:
 * money that has arrived and has not been given a job.
 *
 * Nothing here is stored twice. Allocations are stored; everything below is
 * worked out from them and from the balances as they are now, so a balance
 * that moves overnight is reflected the next time anyone looks rather than
 * whenever a sweep happens to run.
 */

export interface AccountFunding {
  account: Account;
  balance: number;
  /** Given to goals by hand, after trimming to what the balance can back. */
  allocated: number;
  /** Swept to this account's own goal, if it has one. */
  auto: number;
  /**
   * Arrived and not yet given a job.
   *
   * Never below zero any more, because a claim can no longer outrun the
   * balance behind it: see `effectiveClaims`. A balance that falls takes the
   * allocations down with it, so what is left to hand out is simply what is
   * left.
   */
  available: number;
}

export interface Funding {
  accounts: AccountFunding[];
  /** Every goal account's balance, added up. */
  pooled: number;
  allocated: number;
  auto: number;
  /** The headline: what has arrived and is still unassigned. */
  available: number;
}

/** The accounts whose money is on the table, in the order they are shown. */
export function goalAccounts(db: DB): Account[] {
  return db.accounts.filter((a) => a.goalAccount && !a.closedAt);
}

/**
 * What one goal has claimed from one account, as stored.
 *
 * A promise rather than a holding: a balance can fall below what was promised,
 * and what the goal actually has then is `backedClaims`. Nothing but the
 * allocation dialog should be reading this one.
 */
export const claimOn = (goal: Goal, accountId: ID): number => goal.allocations?.[accountId] ?? 0;

/**
 * What each goal really holds of one account, once the balance has fallen
 * below what was promised.
 *
 * An account allocated in full and then spent down used to report the
 * difference as a shortfall for someone to go and correct by hand. That was
 * the wrong job to give a person: the money has gone, the goals cannot have
 * it, and every screen already showed the smaller, true figure. All the
 * shortfall did was sit there, permanently red, on a number nobody could
 * reach — an account with nothing spare offers no room to allocate, so there
 * was no way to take back what was no longer there.
 *
 * So the claims are trimmed to fit instead, least important first: the goal at
 * the top of the list is the one the money was meant for most, and the one at
 * the bottom is the one that gives it up.
 *
 * Trimmed, not rewritten. The allocations on the goals are left exactly as
 * they were, so a balance that comes back brings the claims back with it — the
 * money returned to the same account and it was always meant for the same
 * goals. Writing the cut in would have made a transfer in flight look like a
 * decision somebody made.
 */
export function backedClaims(db: DB, accountId: ID, balance: number): Map<ID, number> {
  const live = db.goals.filter((g) => !g.archived && claimOn(g, accountId) > 0);
  const held = new Map<ID, number>(live.map((g) => [g.id, claimOn(g, accountId)]));

  // Not clamped at zero: an overdrawn account trims every claim to nothing,
  // which is what subtracting a negative already does — the loop below runs
  // out of claims long before it runs out of shortfall. Callers pass a floored
  // balance anyway; a clamp here would be a branch no input can reach.
  let over = live.reduce((s, g) => s + claimOn(g, accountId), 0) - balance;
  if (over <= 0) return held;

  // Highest priority number is the least important goal. Ties keep the order
  // the goals are stored in, so the same balance always trims the same way.
  for (const g of [...live].sort((a, b) => b.priority - a.priority)) {
    if (over <= 0) break;
    const cut = Math.min(held.get(g.id)!, over);
    held.set(g.id, held.get(g.id)! - cut);
    over -= cut;
  }
  return held;
}

/** What one goal really holds of one account, balance and rivals accounted for. */
export function backedClaim(db: DB, goalId: ID, accountId: ID, balance: number): number {
  return backedClaims(db, accountId, balance).get(goalId) ?? 0;
}

/** Everything claimed from one account, across every goal. */
export function claimedFrom(db: DB, accountId: ID): number {
  let total = 0;
  for (const g of db.goals) {
    if (g.archived) continue;
    total += claimOn(g, accountId);
  }
  return total;
}

export function funding(db: DB): Funding {
  const accounts = goalAccounts(db).map((account): AccountFunding => {
    // A goal account holding a negative balance is not money to allocate.
    const balance = Math.max(0, account.balance);
    // Trimmed to fit, so this can never be more than the balance and the
    // spare below can never come out negative.
    const allocated = [...backedClaims(db, account.id, balance).values()].reduce((s, v) => s + v, 0);
    const spare = balance - allocated;
    // An account with a goal of its own has no spare: whatever is not spoken
    // for is already this goal's, which is the entire point of setting one.
    const auto = account.autoGoalId ? spare : 0;
    return { account, balance, allocated, auto, available: spare - auto };
  });

  return {
    accounts,
    pooled: accounts.reduce((s, a) => s + a.balance, 0),
    allocated: accounts.reduce((s, a) => s + a.allocated, 0),
    auto: accounts.reduce((s, a) => s + a.auto, 0),
    available: accounts.reduce((s, a) => s + a.available, 0),
  };
}

/**
 * What one goal actually holds.
 *
 * Its own allocations, plus the leftovers of any account pointed at it, plus
 * whatever was typed in by hand before any of this existed.
 */
export function goalSaved(db: DB, goalId: ID): number {
  const goal = db.goals.find((g) => g.id === goalId);
  if (!goal) return 0;
  let total = goal.startingAmount;
  for (const f of funding(db).accounts) {
    total += backedClaim(db, goalId, f.account.id, f.balance);
    if (f.account.autoGoalId === goalId) total += f.auto;
  }
  return total;
}

/**
 * What a goal held on a given day.
 *
 * The same arithmetic as `goalSaved`, against the balances as they stood then
 * rather than as they stand now. Allocations themselves are not historical —
 * there is one set of them and it is current — so this answers "what would
 * this goal have been worth on that day, split the way it is split today",
 * which is the question a month-to-date change is actually asking.
 *
 * Use it for both ends of a comparison, never mixed with `goalSaved`: a live
 * balance can be ahead of the last dated point in its history, and pairing the
 * two would report that gap as a month's growth.
 */
export function goalSavedAt(db: DB, goalId: ID, date: ISODate): number {
  const goal = db.goals.find((g) => g.id === goalId);
  if (!goal) return 0;
  let total = goal.startingAmount;
  for (const account of goalAccounts(db)) {
    const balance = Math.max(0, balanceAt(account, date));
    const claims = backedClaims(db, account.id, balance);
    total += claims.get(goalId) ?? 0;
    // Whatever an account swept to this goal has left over, as it was then.
    if (account.autoGoalId === goalId) {
      total += balance - [...claims.values()].reduce((s, v) => s + v, 0);
    }
  }
  return total;
}

/** Where a goal's money is, account by account, for the goal's own card. */
export function goalSources(db: DB, goalId: ID): { account: Account; amount: number; auto: boolean }[] {
  const goal = db.goals.find((g) => g.id === goalId);
  if (!goal) return [];
  const out: { account: Account; amount: number; auto: boolean }[] = [];
  for (const f of funding(db).accounts) {
    const claim = backedClaim(db, goalId, f.account.id, f.balance);
    const auto = f.account.autoGoalId === goalId ? f.auto : 0;
    if (claim + auto > 0) out.push({ account: f.account, amount: claim + auto, auto: auto > 0 && claim === 0 });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/**
 * The most this goal could take from this account.
 *
 * What is unassigned, plus whatever this goal already holds there — so the
 * slider in an allocation dialog can be dragged down as well as up without
 * having to release the money first.
 */
export function ceilingFor(db: DB, goalId: ID, accountId: ID): number {
  const goal = db.goals.find((g) => g.id === goalId);
  const f = funding(db).accounts.find((x) => x.account.id === accountId);
  if (!goal || !f) return 0;
  // What is spare, plus what this goal already holds — so the field can be
  // dragged down as well as up without having to release the money first.
  return f.available + backedClaim(db, goalId, accountId, f.balance);
}

/**
 * Setting one goal's claim on one account, clamped to what exists.
 *
 * Returns the database rather than mutating it, and refuses to let the total
 * pass the balance — the invariant the whole feature rests on, enforced in the
 * one place that changes it rather than at every call site.
 */
export function allocate(db: DB, goalId: ID, accountId: ID, amount: number): DB {
  const ceiling = ceilingFor(db, goalId, accountId);
  const next = Math.max(0, Math.min(Math.round(amount), ceiling));
  return {
    ...db,
    goals: db.goals.map((g) => {
      if (g.id !== goalId) return g;
      const allocations = { ...(g.allocations ?? {}) };
      if (next > 0) allocations[accountId] = next;
      else delete allocations[accountId];
      return { ...g, allocations };
    }),
  };
}

/**
 * Turning the old shape into the new one.
 *
 * A goal that named accounts took all of them; two goals naming the same one
 * each took all of it. Handing them out in goal order, up to what the account
 * holds, keeps every total the same as it was wherever the old model was not
 * already double-counting, and stops short of the balance where it was.
 */
export function migrateGoalAccounts(db: DB): DB {
  const needed = db.goals.some((g) => g.accountIds.length && g.allocations === undefined);
  if (!needed) return db;

  const remaining = new Map<ID, number>();
  for (const a of db.accounts) remaining.set(a.id, Math.max(0, a.balance));

  const goals = [...db.goals]
    .sort((a, b) => a.priority - b.priority)
    .map((g) => {
      if (g.allocations !== undefined) return g;
      const allocations: Record<ID, number> = {};
      for (const id of g.accountIds) {
        const left = remaining.get(id) ?? 0;
        if (left <= 0) continue;
        allocations[id] = left;
        remaining.set(id, 0);
      }
      return { ...g, allocations };
    });
  // Back into the order they were stored in, so nothing else notices.
  const byId = new Map(goals.map((g) => [g.id, g]));
  const linked = new Set(db.goals.flatMap((g) => g.accountIds));

  return {
    ...db,
    goals: db.goals.map((g) => byId.get(g.id) ?? g),
    accounts: db.accounts.map((a) => (linked.has(a.id) && a.goalAccount === undefined
      ? { ...a, goalAccount: true }
      : a)),
  };
}

/* ── where a goal is heading ──────────────────────────────────────────── */

export type GoalStatus =
  | "reached" | "ahead" | "behind" | "on track" | "no date"
  /** Nothing is going in and nothing is growing. */
  | "no plan"
  /** Something is going in, and it still never gets there. */
  | "stalled";

export interface GoalOutlook {
  saved: number;
  target: number;
  /** Still to find. Zero once the goal is reached, never negative. */
  remaining: number;
  monthly: number;
  /** The assumed annual return, as a percentage. Zero when none is assumed. */
  growth: number;
  /** Months still needed, or null when it would never get there. */
  monthsNeeded: number | null;
  /** The month it would be reached at the current rate. */
  projected: string | null;
  targetMonth: string | null;
  /** Months of slack against the target date. Negative means late. */
  slack: number | null;
  /**
   * What would have to go in each month to hit the target date, growth
   * included. Null when there is no target date to hit.
   */
  needed: number | null;
  status: GoalStatus;
}

/**
 * The furthest ahead any of this is worth projecting.
 *
 * Eighty years. Past that a goal is not late, it is impossible, and saying
 * "reached in 2431" is a worse answer than saying it never gets there.
 */
const HORIZON = 960;

/**
 * An annual percentage as a monthly one.
 *
 * Compounded, not divided by twelve: 12% a year is 0.949% a month, and a month
 * of 1% is 12.68% a year. Over thirty years the difference is not a rounding.
 */
export const monthlyRate = (annualPercent: number): number =>
  annualPercent === 0 ? 0 : Math.pow(1 + annualPercent / 100, 1 / 12) - 1;

/**
 * The balance after one more month.
 *
 * The month's return first, then the contribution — money paid in at the end
 * of a month has not been invested during it. The optimistic order would
 * flatter every projection here by one month of growth.
 *
 * Rounded to whole cents like every other amount in the app, and rounded here
 * rather than at the point of display so the date and the line that draws it
 * are walking exactly the same steps.
 */
const step = (value: number, rate: number, monthly: number): number =>
  Math.round(value * (1 + rate) + monthly);

/**
 * How many months until this reaches the target, or null if it never does.
 *
 * Walked a month at a time rather than solved, because the closed form has a
 * different shape for a zero rate, another for no contributions, and quietly
 * returns nonsense for a negative one. Eighty steps of arithmetic per goal is
 * nothing, and this way every case is the same case.
 */
export function monthsToReach(saved: number, target: number, monthly: number, annualPercent: number): number | null {
  if (saved >= target) return 0;
  const rate = monthlyRate(annualPercent);
  let value = saved;
  for (let n = 1; n <= HORIZON; n++) {
    value = step(value, rate, monthly);
    if (value >= target) return n;
  }
  // The horizon is what ends this, including the cases that go nowhere at all:
  // with a fixed rate and a fixed contribution, a balance that has stopped
  // climbing never starts again, so there is nothing an early exit would say
  // that eighty years of the same arithmetic does not.
  return null;
}

/**
 * The monthly contribution that would reach the target by then.
 *
 * Found by bisection over the same month-by-month walk `monthsToReach` uses,
 * rather than by the closed-form annuity formula. The formula would be close
 * and not equal: this app rounds every balance to whole cents each month, and
 * a "needed" figure that disagrees with the date drawn beside it is worse than
 * one that takes forty iterations to find.
 *
 * Zero when growth alone gets there in time — which is the whole point of
 * asking, for a retirement pot thirty years out.
 */
export function neededMonthly(saved: number, target: number, months: number, annualPercent: number): number {
  const remaining = Math.max(0, target - saved);
  if (remaining === 0) return 0;
  // No months left to contribute over: it would take all of it, today.
  if (months <= 0) return remaining;
  const reaches = (monthly: number): boolean => {
    const n = monthsToReach(saved, target, monthly, annualPercent);
    return n !== null && n <= months;
  };
  if (reaches(0)) return 0;
  // Paying in the whole shortfall on the first month always arrives, so the
  // answer is somewhere below it.
  let low = 0;
  let high = remaining;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (reaches(mid)) high = mid;
    else low = mid;
  }
  return high;
}

/**
 * When this goal gets there, at the rate money is going in.
 *
 * Contributions plus whatever growth the goal assumes, which is nothing until
 * someone says otherwise. Inventing a return on someone's behalf and
 * presenting the result as a date would be the worse mistake, so the number is
 * theirs to enter; but with it entered, a retirement goal thirty years out
 * stops being wrong by a factor of three.
 */
export function goalOutlook(db: DB, goalId: ID, now: string = thisMonthKey()): GoalOutlook {
  const goal = db.goals.find((g) => g.id === goalId);
  if (!goal) {
    return { saved: 0, target: 0, remaining: 0, monthly: 0, growth: 0, monthsNeeded: null, projected: null, targetMonth: null, slack: null, needed: null, status: "no plan" };
  }
  const saved = goalSaved(db, goalId);
  const target = goal.targetAmount;
  const remaining = Math.max(0, target - saved);
  const monthly = goal.monthlyContribution;
  const growth = goal.growthRate ?? 0;
  const targetMonth = goal.targetDate ? goal.targetDate.slice(0, 7) : null;

  const monthsNeeded = monthsToReach(saved, target, monthly, growth);
  const projected = monthsNeeded === null ? null : addMonthsKey(now, monthsNeeded);
  // Target minus projected, so reaching it early is positive. The other way
  // round reads as "two months ahead" for a goal that lands two months late.
  const slack = projected && targetMonth ? monthsBetween(targetMonth, projected) : null;
  // targetMonth minus now: monthsBetween subtracts its second argument from
  // its first, and the other way round makes every deadline look already past.
  const needed = targetMonth === null ? null : neededMonthly(saved, target, monthsBetween(targetMonth, now), growth);

  const status: GoalStatus =
    remaining === 0 ? "reached"
    // Never getting there is two different things. Nothing going in is a plan
    // waiting to be made; money going in that still falls short is a plan that
    // does not work, and saying "nothing going in" about it would be a lie.
    : monthsNeeded === null ? (monthly <= 0 && growth <= 0 ? "no plan" : "stalled")
    : targetMonth === null ? "no date"
    : slack === null ? "no date"
    : slack > 0 ? "ahead"
    : slack < 0 ? "behind"
    : "on track";

  return { saved, target, remaining, monthly, growth, monthsNeeded, projected, targetMonth, slack, needed, status };
}

export interface ProjectedMonth {
  month: string;
  value: number;
  /** What it would be with no growth: the money actually put in. */
  contributed: number;
}

/**
 * The line from here to the target, a month at a time.
 *
 * Runs to whichever is later, the target date or the month it would actually
 * be reached, so a goal that is behind shows how far past the date it lands
 * rather than stopping at the date and looking finished.
 *
 * Carries the contributions on their own alongside the total, so the gap
 * between the two — which is the entire claim a growth rate makes — can be
 * shown rather than asserted.
 */
export function goalProjection(
  db: DB,
  goalId: ID,
  now: string = thisMonthKey(),
  cap = 480,
): ProjectedMonth[] {
  const o = goalOutlook(db, goalId, now);
  const ends = [o.targetMonth, o.projected].filter((m): m is string => !!m);
  if (!ends.length) return [];
  const last = ends.sort()[ends.length - 1]!;
  const span = Math.min(cap, Math.max(1, monthsBetween(last, now)));
  const rate = monthlyRate(o.growth);
  const out: ProjectedMonth[] = [];
  let value = o.saved;
  for (let i = 0; i <= span; i++) {
    if (i > 0) value = step(value, rate, o.monthly);
    out.push({ month: addMonthsKey(now, i), value, contributed: o.saved + o.monthly * i });
  }
  return out;
}

/* Local date helpers, so this module stays free of the date module's DOM-free
 * import rules and can be read on its own. */
const thisMonthKey = (): string => new Date().toISOString().slice(0, 7);

function addMonthsKey(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y! * 12 + (m! - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** Months from `b` to `a`. Positive when `a` is later. */
function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (ay! * 12 + am!) - (by! * 12 + bm!);
}
