import type { DB, MonthKey } from "../types";
import { budgetTable, plannedFor } from "./select";

export interface MoveCandidate {
  categoryId: string;
  name: string;
  icon: string;
  color: string;
  planned: number;
  remaining: number;
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

/** The move that would square both sides, without overdrawing either. */
export function suggestedAmount(from: MoveCandidate | undefined, to: MoveCandidate | undefined): number {
  if (!from || !to) return 0;
  const surplus = Math.max(0, Math.min(from.remaining, from.planned));
  const shortfall = Math.max(0, -to.remaining);
  return Math.min(surplus, shortfall);
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
  const moved = Math.min(amount, fromPlanned);
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
