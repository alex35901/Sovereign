import type { ID, Transaction } from "../types.js";

/**
 * Finding transactions that are the same thing twice.
 *
 * The import already refuses a row it has seen before, keyed on account, date,
 * amount and merchant — so anything that got past it differed in one of those.
 * A file mapped to a different merchant column, or imported into the wrong
 * account, produces rows that are plainly duplicates to a person and plainly
 * distinct to that key.
 *
 * Which makes this the opposite problem, and a dangerous one: loosen the key
 * far enough to catch those and it starts catching real pairs. Two coffees on
 * the same day at the same price is an ordinary Tuesday, not a mistake. So
 * nothing here deletes anything — it groups, explains, and hands the decision
 * back.
 */

export interface DupeOptions {
  /** Same merchant name as well. Off catches a re-import that mapped the
   *  merchant column differently, at the cost of matching more loosely. */
  sameMerchant: boolean;
  /** Same account. Off catches a file imported into the wrong account twice. */
  sameAccount: boolean;
  /** Days apart the dates may be. 0 means the same day. */
  dayTolerance: number;
}

export const DEFAULT_OPTIONS: DupeOptions = { sameMerchant: true, sameAccount: true, dayTolerance: 0 };

export interface DupeGroup {
  /** The one to keep, chosen rather than arbitrary — see `preferred`. */
  keep: Transaction;
  /** The copies, in the order they would be removed. */
  drop: Transaction[];
}

const DAY = 86_400_000;
const dayNumber = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY);

/** A transaction the provider gave us, rather than one from a file. */
export const isSynced = (t: Transaction): boolean => /^(sf|pl):/.test(t.importKey ?? "");

/**
 * Which of a set of copies to keep.
 *
 * A synced one wins outright: it is tied to the provider's own id, so it keeps
 * updating and the next sync would re-create it anyway if it were deleted. Then
 * whichever carries more of your work — a category, a review, notes, tags —
 * because that is the one you have touched. Age breaks the remaining ties, on
 * the grounds that the accidental copy is the newer one.
 */
export function preferred(a: Transaction, b: Transaction): Transaction {
  if (isSynced(a) !== isSynced(b)) return isSynced(a) ? a : b;
  const worth = (t: Transaction): number =>
    (t.reviewed ? 4 : 0)
    + (t.categoryId && t.categoryId !== "uncat" ? 2 : 0)
    + (t.notes ? 1 : 0)
    + (t.tags.length ? 1 : 0)
    + ((t.splits?.length ?? 0) > 0 ? 8 : 0);
  const wa = worth(a);
  const wb = worth(b);
  if (wa !== wb) return wa > wb ? a : b;
  const ca = a.createdAt ?? "";
  const cb = b.createdAt ?? "";
  if (ca !== cb) return ca < cb ? a : b;
  return a.id <= b.id ? a : b;
}

/**
 * Groups of transactions that look like the same thing more than once.
 *
 * Only groups of two or more come back, and every group names one to keep, so
 * a caller that deletes every `drop` can never empty a group entirely.
 */
export function findDuplicates(
  transactions: Transaction[],
  opts: DupeOptions = DEFAULT_OPTIONS,
): DupeGroup[] {
  const buckets = new Map<string, Transaction[]>();
  for (const t of transactions) {
    // A split is a deliberate structure, not an accident, and deleting half of
    // one would leave a budget that no longer adds up.
    if ((t.splits?.length ?? 0) > 0) continue;
    const key = [
      opts.sameAccount ? t.accountId : "",
      t.amount,
      opts.sameMerchant ? t.merchant.toLowerCase().trim() : "",
    ].join("|");
    const bucket = buckets.get(key);
    if (bucket) bucket.push(t);
    else buckets.set(key, [t]);
  }

  const groups: DupeGroup[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const byDate = [...bucket].sort((a, b) =>
      a.date === b.date ? (a.createdAt ?? "").localeCompare(b.createdAt ?? "") : a.date.localeCompare(b.date));

    // Cluster along the dates rather than comparing every pair: with a
    // tolerance of two days, the 1st, 2nd and 3rd are one run, and the 5th
    // starts a new one rather than being dragged in by the 3rd.
    let run: Transaction[] = [];
    let anchor = -Infinity;
    const flush = () => {
      if (run.length >= 2) groups.push(intoGroup(run));
      run = [];
    };
    for (const t of byDate) {
      const day = dayNumber(t.date);
      if (!run.length || day - anchor <= opts.dayTolerance) {
        if (!run.length) anchor = day;
        run.push(t);
      } else {
        flush();
        anchor = day;
        run.push(t);
      }
    }
    flush();
  }

  // Most copies first: the worst offenders are what you want to look at.
  return groups.sort((a, b) =>
    b.drop.length - a.drop.length || a.keep.date.localeCompare(b.keep.date));
}

function intoGroup(run: Transaction[]): DupeGroup {
  const keep = run.reduce((best, t) => preferred(best, t));
  return { keep, drop: run.filter((t) => t.id !== keep.id) };
}

/** Every id a caller would remove, across all the groups it is keeping. */
export const idsToDrop = (groups: DupeGroup[]): ID[] => groups.flatMap((g) => g.drop.map((t) => t.id));

export interface DupeSummary {
  groups: number;
  duplicates: number;
  /** Net effect on the balance of what would be removed, in cents. */
  amount: number;
}

export function summarise(groups: DupeGroup[]): DupeSummary {
  const drop = groups.flatMap((g) => g.drop);
  return {
    groups: groups.length,
    duplicates: drop.length,
    amount: drop.reduce((sum, t) => sum + t.amount, 0),
  };
}
