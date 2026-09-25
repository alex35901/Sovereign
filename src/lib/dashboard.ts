import type { DB, Goal, ISODate, MonthKey, Recurring } from "../types.js";
import { daysInMonth, monthEnd, monthOf, monthStart, today } from "./date.js";
import { counts, lines, recurringList } from "./select.js";
import { goalOutlook, goalSaved, goalSavedAt } from "./goal-funding.js";
import type { GoalStatus } from "./goal-funding.js";

/**
 * The figures the dashboard puts side by side.
 *
 * Kept out of the screen because every one of them is a comparison, and a
 * comparison drawn from two differently-worked-out numbers is worse than no
 * comparison at all: this month's spending against last month's has to count
 * the same transactions the same way on both sides, or the shape of the
 * difference is an artefact of the code rather than of the money.
 */

/* ── spending ─────────────────────────────────────────────────────────── */

/**
 * What was spent on each day between two dates.
 *
 * The one place that decides what spending is, so that every comparison on the
 * dashboard counts the same transactions the same way. The rules in here are
 * the whole reason: which accounts are muted, which categories are money
 * moving rather than money going, and that a split counts per line. A second
 * implementation of any of that is a second answer to "what did we spend".
 */
export function spendByDay(
  db: DB,
  from: ISODate,
  to: ISODate,
  muted: Set<string>,
  moving: Set<string>,
): Map<ISODate, number> {
  const daily = new Map<ISODate, number>();
  for (const t of db.transactions) {
    if (t.date < from || t.date > to) continue;
    if (!counts(t, muted)) continue;
    // Per line, so a shop split between groceries and a transfer contributes
    // the groceries and not the transfer.
    for (const l of lines(t)) {
      // Spending only: a payday landing mid-month would otherwise walk the
      // line backwards and turn "spent so far" into "net so far", which is a
      // different question and the one the budget card answers.
      if (l.amount >= 0) continue;
      // And only the kind of leaving that is spending. A credit card paid off
      // is the same money twice: it left as the groceries bought on the card,
      // and it leaves again as the payment. So is a transfer into savings,
      // which has not been spent at all.
      if (moving.has(l.categoryId)) continue;
      daily.set(t.date, (daily.get(t.date) ?? 0) + -l.amount);
    }
  }
  return daily;
}

/**
 * How far through a month a day is, 0 to 1.
 *
 * Counted in whole days elapsed, so the first of the month is not already
 * 1/31 of the way through before anything has happened, and the last day of
 * the month reads as full rather than as one day short of it.
 */
export function monthProgress(month: MonthKey, now: ISODate = today()): number {
  if (monthOf(now) < month) return 0;
  if (monthOf(now) > month) return 1;
  return Number(now.slice(8, 10)) / daysInMonth(month);
}

/**
 * Spending is ahead of the calendar, not merely under way.
 *
 * A plan is spread across a month, so half of it gone on the second is a
 * different situation from half of it gone on the fifteenth, and only the
 * first is worth colouring red. Being over the plan outright is caught by the
 * same rule: the month is never more than fully elapsed, so anything past the
 * plan is also past the plan's pace.
 */
export function overPace(planned: number, actual: number, progress: number): boolean {
  if (planned <= 0) return actual > 0;
  return actual > planned * progress;
}

/* ── goals ────────────────────────────────────────────────────────────── */

export interface GoalMove {
  goal: Goal;
  /** What it is worth now, as the goals screen reports it. */
  saved: number;
  /** How that moved since the first of the month. */
  change: number;
  pct: number | null;
  status: GoalStatus;
}

/**
 * Every goal, and how it moved this month.
 *
 * Both ends of the change are valued the same way, at two dates, rather than
 * comparing a dated figure with the live one — see goalSavedAt. The headline
 * figure is the live one, because that is what every other screen shows for a
 * goal and a dashboard disagreeing with the page it links to is worse than a
 * dashboard that is a few pounds behind.
 */
export function goalMoves(db: DB, now: ISODate = today()): { goals: GoalMove[]; change: number; pct: number } {
  const start = monthStart(monthOf(now));
  const goals = db.goals
    .filter((g) => !g.archived)
    .sort((a, b) => a.priority - b.priority)
    .map((g): GoalMove => {
      const then = goalSavedAt(db, g.id, start);
      const nowValue = goalSavedAt(db, g.id, now);
      const change = nowValue - then;
      return {
        goal: g,
        saved: goalSaved(db, g.id),
        change,
        pct: then === 0 ? null : change / Math.abs(then),
        status: goalOutlook(db, g.id).status,
      };
    });
  const change = goals.reduce((s, g) => s + g.change, 0);
  const before = goals.reduce((s, g) => s + (goalSavedAt(db, g.goal.id, start)), 0);
  return { goals, change, pct: before === 0 ? 0 : change / Math.abs(before) };
}

/* ── what is still to come out ────────────────────────────────────────── */

export interface DueSoon {
  items: Recurring[];
  /** Money still expected to leave before the month is out. */
  remaining: number;
}

/**
 * The recurring charges still ahead of you this month.
 *
 * Only what is left: a subscription that came out on the 3rd is spent money
 * and belongs in the spending figure, not in "remaining due". Outgoings only
 * for the total, because "remaining due" is a bill, and netting an expected
 * paycheque against it would report a number nobody owes.
 */
export function dueSoon(db: DB, now: ISODate = today(), limit = 6): DueSoon {
  const end = monthEnd(monthOf(now));
  const ahead = recurringList(db).filter((r) => r.nextDate >= now);
  return {
    items: ahead.slice(0, limit),
    remaining: ahead
      .filter((r) => r.nextDate <= end && r.amount < 0)
      .reduce((s, r) => s + -r.amount, 0),
  };
}
