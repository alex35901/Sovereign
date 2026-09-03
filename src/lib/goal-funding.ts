import type { Account, DB, Goal, ID } from "../types.js";

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
  /** Given to goals by hand. */
  allocated: number;
  /** Swept to this account's own goal, if it has one. */
  auto: number;
  /** Arrived and not yet given a job. Never negative. */
  available: number;
  /**
   * Allocated beyond what is in the account.
   *
   * Happens when a balance falls after the money was assigned — a market drop,
   * or a withdrawal. Surfaced rather than quietly clamped, because a goal
   * showing money the account no longer holds is the sort of wrong that only
   * turns up when it is spent.
   */
  over: number;
}

export interface Funding {
  accounts: AccountFunding[];
  /** Every goal account's balance, added up. */
  pooled: number;
  allocated: number;
  auto: number;
  /** The headline: what has arrived and is still unassigned. */
  available: number;
  over: number;
}

/** The accounts whose money is on the table, in the order they are shown. */
export function goalAccounts(db: DB): Account[] {
  return db.accounts.filter((a) => a.goalAccount && !a.closedAt);
}

/** What each goal has claimed from one account. */
export const claimOn = (goal: Goal, accountId: ID): number => goal.allocations?.[accountId] ?? 0;

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
    const claimed = claimedFrom(db, account.id);
    const allocated = Math.min(claimed, balance);
    const over = Math.max(0, claimed - balance);
    const spare = balance - allocated;
    // An account with a goal of its own has no spare: whatever is not spoken
    // for is already this goal's, which is the entire point of setting one.
    const auto = account.autoGoalId ? spare : 0;
    return { account, balance, allocated, auto, available: spare - auto, over };
  });

  return {
    accounts,
    pooled: accounts.reduce((s, a) => s + a.balance, 0),
    allocated: accounts.reduce((s, a) => s + a.allocated, 0),
    auto: accounts.reduce((s, a) => s + a.auto, 0),
    available: accounts.reduce((s, a) => s + a.available, 0),
    over: accounts.reduce((s, a) => s + a.over, 0),
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
    total += Math.min(claimOn(goal, f.account.id), f.balance);
    if (f.account.autoGoalId === goalId) total += f.auto;
  }
  return total;
}

/** Where a goal's money is, account by account, for the goal's own card. */
export function goalSources(db: DB, goalId: ID): { account: Account; amount: number; auto: boolean }[] {
  const goal = db.goals.find((g) => g.id === goalId);
  if (!goal) return [];
  const out: { account: Account; amount: number; auto: boolean }[] = [];
  for (const f of funding(db).accounts) {
    const claim = Math.min(claimOn(goal, f.account.id), f.balance);
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
  return f.available + Math.min(claimOn(goal, accountId), f.balance);
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

export type GoalStatus = "reached" | "ahead" | "behind" | "on track" | "no date" | "no plan";

export interface GoalOutlook {
  saved: number;
  target: number;
  /** Still to find. Zero once the goal is reached, never negative. */
  remaining: number;
  monthly: number;
  /** Months of contributions still needed, or null when nothing is being put in. */
  monthsNeeded: number | null;
  /** The month it would be reached at the current rate. */
  projected: string | null;
  targetMonth: string | null;
  /** Months of slack against the target date. Negative means late. */
  slack: number | null;
  status: GoalStatus;
}

/**
 * When this goal gets there, at the rate money is going in.
 *
 * Contributions only — no assumed rate of return. A retirement goal decades
 * out really will grow faster than this says, but the alternative is inventing
 * a percentage on someone's behalf and presenting the result as a date, which
 * is a worse kind of wrong than being conservative.
 */
export function goalOutlook(db: DB, goalId: ID, now: string = thisMonthKey()): GoalOutlook {
  const goal = db.goals.find((g) => g.id === goalId);
  if (!goal) {
    return { saved: 0, target: 0, remaining: 0, monthly: 0, monthsNeeded: null, projected: null, targetMonth: null, slack: null, status: "no plan" };
  }
  const saved = goalSaved(db, goalId);
  const target = goal.targetAmount;
  const remaining = Math.max(0, target - saved);
  const monthly = goal.monthlyContribution;
  const targetMonth = goal.targetDate ? goal.targetDate.slice(0, 7) : null;

  const monthsNeeded = remaining === 0 ? 0 : monthly > 0 ? Math.ceil(remaining / monthly) : null;
  const projected = monthsNeeded === null ? null : addMonthsKey(now, monthsNeeded);
  // Target minus projected, so reaching it early is positive. The other way
  // round reads as "two months ahead" for a goal that lands two months late.
  const slack = projected && targetMonth ? monthsBetween(targetMonth, projected) : null;

  const status: GoalStatus =
    remaining === 0 ? "reached"
    : monthsNeeded === null ? "no plan"
    : targetMonth === null ? "no date"
    : slack === null ? "no date"
    : slack > 0 ? "ahead"
    : slack < 0 ? "behind"
    : "on track";

  return { saved, target, remaining, monthly, monthsNeeded, projected, targetMonth, slack, status };
}

/**
 * The line from here to the target, a month at a time.
 *
 * Runs to whichever is later, the target date or the month it would actually
 * be reached, so a goal that is behind shows how far past the date it lands
 * rather than stopping at the date and looking finished.
 */
export function goalProjection(
  db: DB,
  goalId: ID,
  now: string = thisMonthKey(),
  cap = 480,
): { month: string; value: number }[] {
  const o = goalOutlook(db, goalId, now);
  const ends = [o.targetMonth, o.projected].filter((m): m is string => !!m);
  if (!ends.length) return [];
  const last = ends.sort()[ends.length - 1]!;
  const span = Math.min(cap, Math.max(1, monthsBetween(last, now)));
  const out: { month: string; value: number }[] = [];
  for (let i = 0; i <= span; i++) {
    out.push({ month: addMonthsKey(now, i), value: o.saved + o.monthly * i });
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
