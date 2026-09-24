/**
 * Folding several spellings of one shop into a single merchant.
 *
 * A restaurant group bills as "Coopershawk", "Coopers Hawk Indianapoli",
 * "Cooper's Hawk Winery & Restaurant", "Coopers Hawk Wine" and "Coopers Hawk
 * Member Si", and every one of those is a separate merchant, a separate line
 * on the merchants page, and, worse, a separate recurring bill. A subscription
 * charged monthly is never ticked off, because the name it arrived under is
 * not the name the schedule is filed under.
 *
 * The fix is a rule, because rules already do all of this: they rename on the
 * way in, they can be run back over what is already held, and they are visible
 * and editable afterwards rather than being a hidden alias table. What is here
 * is the arithmetic around choosing one safely.
 */

export interface MergeRow {
  /** The spelling shown on the merchants page. */
  name: string;
  count: number;
}

/** How short a match may be before it is more likely to catch the wrong shop. */
export const MIN_MATCH = 3;

/**
 * Exactly what the rules engine does to a name before comparing it, and no
 * more.
 *
 * Tempting to strip punctuation here so "coopers hawk" reaches "Cooper's Hawk
 * Winery". It must not: the rule that ends up doing the renaming compares with
 * a plain substring test, so a preview that were more forgiving than the rule
 * would be a preview that lies about what is about to happen. See ruleMatches.
 */
const norm = (s: string): string => s.toLowerCase().trim();

/**
 * The spelling to keep.
 *
 * The one the most transactions already use, so the fewest rows have to be
 * rewritten and the name on the page is the one that is actually familiar.
 * Ties go to the longer spelling, which is the one more likely to be the
 * shop's full name rather than a truncation of it: "Coopers Hawk Wine" over
 * "Coopers Hawk Win".
 */
export function suggestName(rows: readonly MergeRow[]): string {
  const best = [...rows].sort((a, b) =>
    (b.count - a.count) || (b.name.length - a.name.length) || a.name.localeCompare(b.name));
  return best[0]?.name ?? "";
}

/**
 * Whether every chosen spelling would actually be caught by this match.
 *
 * A rule that misses one of them leaves that spelling behind as its own
 * merchant and its own recurring bill, which is the whole problem, unfixed and
 * now harder to see.
 */
export function missedBy(rows: readonly MergeRow[], match: string): MergeRow[] {
  const want = norm(match);
  if (!want) return [...rows];
  return rows.filter((r) => !norm(r.name).includes(want));
}

/**
 * The merchants outside this merge that the same rule would also rename.
 *
 * The check that matters. A rule is a blunt instrument pointed at every
 * transaction in the document, past and future, and "contains cooper" is
 * obviously safe in a way that "contains a" is obviously not. Nothing here
 * decides for anybody: it counts what would happen and hands it back to be
 * looked at.
 */
export function alsoCaught(
  all: readonly MergeRow[],
  match: string,
  chosen: readonly string[],
): MergeRow[] {
  const want = norm(match);
  if (want.length < MIN_MATCH) return [];
  const picked = new Set(chosen.map(norm));
  return all.filter((r) => !picked.has(norm(r.name)) && norm(r.name).includes(want));
}

/** How many transactions this merge would rewrite. */
export const movedBy = (rows: readonly MergeRow[], keep: string): number =>
  rows.filter((r) => norm(r.name) !== norm(keep)).reduce((n, r) => n + r.count, 0);

export interface MergeCheck {
  /** Chosen spellings the match would not reach. */
  missed: MergeRow[];
  /** Merchants outside the merge the match would rename as well. */
  extra: MergeRow[];
  /** Transactions that would be renamed. */
  moving: number;
  /** Whether this is safe to do without reading anything further. */
  clean: boolean;
  /** Why it is not, in one line, when it is not. */
  warning?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Everything worth knowing before pressing the button. */
export function checkMerge(
  all: readonly MergeRow[],
  chosen: readonly MergeRow[],
  match: string,
  keep: string,
): MergeCheck {
  const missed = missedBy(chosen, match);
  const extra = alsoCaught(all, match, chosen.map((r) => r.name));
  const moving = movedBy(chosen, keep);
  const short = norm(match).length < MIN_MATCH;

  const warning = short
    ? `"${match}" is too short to match on safely. Use at least ${MIN_MATCH} characters.`
    : missed.length
      ? `${missed.map((r) => r.name).join(", ")} would not be matched by "${match}", so ${missed.length === 1 ? "it stays" : "they stay"} separate.`
      : extra.length
        ? `This would also rename ${plural(extra.length, "other merchant")}: ${extra.map((r) => r.name).join(", ")}.`
        : undefined;

  return { missed, extra, moving, clean: !warning, warning };
}
