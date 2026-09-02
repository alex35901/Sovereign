import type { Category, CategoryGroup, DB } from "../types.js";

/**
 * Colour belongs to the group, not the category.
 *
 * Fifty categories each with their own colour is fifty decisions nobody wants
 * to make and a transaction list that reads as confetti. A group is the useful
 * unit: everything under Food & Dining looks like food, Transfers recede into
 * grey, and the eye can sort a page of pills without reading any of them.
 *
 * `category.color` stays the field everything renders, because twenty-odd call
 * sites read it and threading a lookup through every selector would be a lot of
 * churn for no behaviour. It is derived instead: `withGroupColors` runs on every
 * write and makes each category match its group, so the two cannot drift — not
 * when a group's colour changes, and not when a category is moved to another
 * group, which is the case a hand-maintained copy would always miss.
 */

/** The palette, in the order a new group picks from. */
export const GROUP_TONES = [
  "--c1", "--c2", "--c3", "--c4", "--c5", "--c6",
  "--c7", "--c8", "--c9", "--c10", "--c11", "--c12",
] as const;

/** Stable per group, so a group with no colour yet still looks deliberate. */
const fromId = (id: string): string => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return GROUP_TONES[hash % GROUP_TONES.length]!;
};

/**
 * The colour a group's categories should be.
 *
 * A group that has never been given one takes whichever colour its categories
 * most commonly already are. Categories that differed do change — one colour
 * per group is the whole point — but the group lands on its most familiar tone
 * rather than an arbitrary one, so the least possible moves. Only a group whose
 * categories say nothing falls back to its own id.
 */
export function groupColor(group: CategoryGroup, categories: Category[]): string {
  if (group.color) return group.color;

  const counts = new Map<string, number>();
  for (const c of categories) {
    if (c.groupId !== group.id || !c.color) continue;
    counts.set(c.color, (counts.get(c.color) ?? 0) + 1);
  }
  let best: string | null = null;
  let most = 0;
  for (const [tone, n] of counts) {
    // Ties break on the tone's own name so the answer never depends on the
    // order categories happen to be stored in.
    if (n > most || (n === most && best !== null && tone < best)) { best = tone; most = n; }
  }
  return best ?? fromId(group.id);
}

/**
 * Every category wearing its group's colour.
 *
 * Returns the same database object when nothing needed changing, so it is safe
 * to run on every single write.
 */
export function withGroupColors(db: DB): DB {
  const byGroup = new Map<string, string>();
  for (const g of db.groups) byGroup.set(g.id, groupColor(g, db.categories));

  let changed = false;
  const categories = db.categories.map((c) => {
    const want = byGroup.get(c.groupId);
    if (!want || c.color === want) return c;
    changed = true;
    return { ...c, color: want };
  });
  return changed ? { ...db, categories } : db;
}
