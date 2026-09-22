/**
 * Which of Actual and Remaining the budget sheet shows, on a screen with room
 * for one of them.
 *
 * Planned, Actual and Remaining side by side is three columns of numbers
 * against a category name, and on a phone the name loses. Showing one of the
 * two and letting it be swapped keeps both reachable without spending the
 * width twice, which is the trade a narrow screen is actually asking for.
 *
 * Wide screens show both and this does nothing at all.
 */
export type BudgetColumn = "actual" | "remaining";

/**
 * Remaining, because it is the one that is acted on.
 *
 * It is also the column carrying the control that moves money between
 * categories, and the hover card behind it already states the actual. Actual
 * on its own states nothing about whether anything needs doing.
 */
export const DEFAULT_COLUMN: BudgetColumn = "remaining";

/** The other one, which is what pressing the header asks for. */
export const otherColumn = (c: BudgetColumn): BudgetColumn => (c === "actual" ? "remaining" : "actual");

export const COLUMN_LABEL: Record<BudgetColumn, string> = { actual: "Actual", remaining: "Remaining" };

/**
 * What a stored preference means.
 *
 * Anything that is not one of the two is the default rather than a crash: this
 * comes out of localStorage, which survives across versions and can hold
 * whatever an older one of those versions wrote.
 */
export function readColumn(raw: string | null | undefined): BudgetColumn {
  return raw === "actual" || raw === "remaining" ? raw : DEFAULT_COLUMN;
}

/**
 * What the header says to a screen reader.
 *
 * A dotted underline says "press me" to someone who can see it and nothing at
 * all to anyone else, so the label has to say both what is shown and what
 * pressing it would show instead.
 */
export function toggleHint(showing: BudgetColumn): string {
  return `Showing ${COLUMN_LABEL[showing].toLowerCase()}. Press to show ${COLUMN_LABEL[otherColumn(showing)].toLowerCase()} instead.`;
}
