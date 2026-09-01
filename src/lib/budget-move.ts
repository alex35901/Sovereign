import type { DB, MonthKey } from "../types";
import { budgetTable, plannedFor } from "./select";

export interface MoveCandidate {
  categoryId: string;
  name: string;
  icon: string;
  color: string;
  planned: number;
  remaining: number;
  rollover: number;
}

/** Every expense category in play this month, with what's left in it. */
export function moveCandidates(db: DB, month: MonthKey): MoveCandidate[] {
  return budgetTable(db, month)
    .filter((g) => g.group.kind === "expense")
    .flatMap((g) => g.rows)
    .map((r) => ({
      categoryId: r.category.id,
      name: r.category.name,
      icon: r.category.icon,
      color: r.category.color,
      planned: r.planned,
      remaining: r.remaining,
      rollover: r.rollover,
    }));
}

/**
 * Picks the other side of the move.
 *
 * Money is being taken from a category with something left, and given to one
 * that has overspent — so a surplus looks for the deepest hole, and a shortfall
 * looks for the biggest surplus.
 */
export function suggestCounterpart(
  candidates: MoveCandidate[],
  selectedId: string,
  direction: "from" | "to",
): MoveCandidate | undefined {
  const others = candidates.filter((c) => c.categoryId !== selectedId);
  if (!others.length) return undefined;
  const sorted = [...others].sort((a, b) => a.remaining - b.remaining);
  if (direction === "to") {
    // the selected category is the source: find the deepest overspend
    const worst = sorted[0];
    return worst.remaining < 0 ? worst : undefined;
  }
  // the selected category is the destination: find the largest surplus that
  // actually has budget to give
  const best = [...sorted].reverse().find((c) => c.remaining > 0 && c.planned > 0);
  return best;
}

/**
 * The spare money in a category — what a move should offer to take by default.
 *
 * For an ordinary category that is this month's plan less what's been spent.
 * A rollover category can also give away what carried in, so its surplus is
 * simply what's left, which is usually more than the month's plan.
 */
export function surplusOf(from: MoveCandidate): number {
  return from.rollover > 0
    ? Math.max(0, from.remaining)
    : Math.max(0, Math.min(from.remaining, from.planned));
}

/**
 * The hard ceiling on a move out of a category — more than the surplus, since
 * a category may deliberately be pushed into overspend to cover another.
 * A rollover category stops at what's left: past that it would be giving away
 * money it never had.
 */
export function moveCeiling(from: MoveCandidate): number {
  return from.rollover > 0 ? Math.max(0, from.remaining) : Math.max(0, from.planned);
}

/** The move that would square both sides, without overdrawing either. */
export function suggestedAmount(from: MoveCandidate | undefined, to: MoveCandidate | undefined): number {
  if (!from || !to) return 0;
  const shortfall = Math.max(0, -to.remaining);
  return Math.min(surplusOf(from), shortfall);
}

export interface MoveResult { db: DB; moved: number }

/**
 * Moves planned money between two categories for one month.
 *
 * Only this month's figures change: a standing amount set by "apply to all
 * future months" keeps applying from next month, which is what makes this a
 * correction rather than a re-plan. Nothing can be taken beyond what a category
 * actually holds.
 */
export function moveBudget(db: DB, month: MonthKey, fromId: string, toId: string, amount: number): MoveResult {
  if (!fromId || !toId || fromId === toId || amount <= 0) return { db, moved: 0 };

  const fromPlanned = plannedFor(db, month, fromId);
  const toPlanned = plannedFor(db, month, toId);
  const source = moveCandidates(db, month).find((c) => c.categoryId === fromId);
  // A rollover category may give away more than this month's plan, which drives
  // that month's planned figure negative — correct, since what's left lands on
  // zero rather than below it.
  const ceiling = source ? moveCeiling(source) : Math.max(0, fromPlanned);
  const moved = Math.min(amount, ceiling);
  if (moved <= 0) return { db, moved: 0 };

  return {
    db: {
      ...db,
      budgets: {
        ...db.budgets,
        [month]: {
          ...(db.budgets[month] ?? {}),
          // written explicitly, including a zero: deleting the entry would let
          // a standing amount reappear and undo the move
          [fromId]: fromPlanned - moved,
          [toId]: toPlanned + moved,
        },
      },
    },
    moved,
  };
}
