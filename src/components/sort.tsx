import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cx } from "./ui";

/**
 * Sorting a table by clicking its headings.
 *
 * Three states rather than two, because two is a trap: once a table has been
 * sorted there is no way back to the order it was in, and that order usually
 * means something. Holdings arrive biggest-first within their account, an
 * integrations list is in the order the work actually runs. A third click
 * gives that back.
 */

export type SortDir = "asc" | "desc";
export interface Sort<K extends string> { key: K; dir: SortDir }

/**
 * How one row's value for one column is read, and it may be absent.
 *
 * Null is a real answer here, not a missing one: a position the price
 * provider has never heard of has no return to report. Those rows sort to the
 * bottom whichever way the arrow points, because the alternative is that
 * "worst performers" opens with a list of things that have no performance.
 */
export type SortValue = string | number | null | undefined;

/** Ascending, then descending, then back to the order it came in. */
export function useSort<K extends string>(initial: Sort<K> | null = null) {
  const [sort, setSort] = useState<Sort<K> | null>(initial);
  const toggle = useCallback((key: K) => {
    setSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: "asc" };
      if (cur.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }, []);
  return { sort, toggle, setSort };
}

/**
 * Whether a cell has no answer.
 *
 * NaN counts, and has to: a return worked out from a price of zero is not a
 * small number, it is no number, and NaN compares false against everything so
 * left alone it scatters its rows wherever the sort happens to walk.
 */
export const isMissing = (v: SortValue): boolean =>
  v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v));

/** -1, 0 or 1 for two values of the same column, absent ones last. */
export function compareValues(a: SortValue, b: SortValue): number {
  const aMissing = isMissing(a);
  const bMissing = isMissing(b);
  if (aMissing || bMissing) return aMissing && bMissing ? 0 : aMissing ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  // Numeric collation, so "Holding 2" comes before "Holding 10" and a ticker
  // is compared without its case deciding anything.
  return String(a).localeCompare(String(b), "en", { sensitivity: "base", numeric: true });
}

/**
 * A copy of `rows` in the order asked for, or the original when nothing is.
 *
 * The missing-rows-last rule is applied before the direction, which is why the
 * comparison is not simply negated for descending: negating it would float
 * every unpriceable row to the top the moment somebody clicked twice.
 */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  sort: Sort<K> | null,
  value: (row: T, key: K) => SortValue,
): T[] {
  if (!sort) return [...rows];
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((x, y) => {
    const a = value(x, sort.key);
    const b = value(y, sort.key);
    // The same test as compareValues uses, deliberately: this one has to run
    // before the direction is applied, or a descending sort would negate it
    // and float every row that has no answer to the top.
    if (isMissing(a) || isMissing(b)) return isMissing(a) && isMissing(b) ? 0 : isMissing(a) ? 1 : -1;
    return compareValues(a, b) * dir;
  });
}

/** A heading that sorts its column, and says which way it is pointing. */
export function SortTh<K extends string>({ field, sort, onSort, children, className, width }: {
  field: K;
  sort: Sort<K> | null;
  onSort: (key: K) => void;
  children: ReactNode;
  className?: string;
  width?: number;
}) {
  const on = sort?.key === field;
  const dir = on ? sort.dir : null;
  return (
    <th
      className={cx("th-sort", on && "on", className)}
      style={width ? { width } : undefined}
      // Read out by a screen reader, and the one thing a test can assert that
      // is not a picture of an arrow.
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        title={
          dir === "asc" ? "Sorted low to high. Click for high to low."
            : dir === "desc" ? "Sorted high to low. Click to clear."
            : "Click to sort"
        }
      >
        <span className="truncate">{children}</span>
        {dir === "asc" ? <ArrowUp size={12} /> : dir === "desc" ? <ArrowDown size={12} /> : null}
      </button>
    </th>
  );
}
