import type { Account, DB, Holding, ISODate } from "../types.js";
import type { PriceHistory } from "./benchmarks.js";
import { closeOn } from "./benchmarks.js";
import { ASSET_CLASS_LABEL, holdingValue } from "./select.js";

/**
 * How a list of positions is cut up, and what each row has done lately.
 *
 * The table used to be one card per account because that is how the data
 * arrives. It is not the only question worth asking of it: "how much of this
 * is in bonds" and "how much of it is at Fidelity" are different questions,
 * and the same rows answer all of them.
 */

export type GroupBy = "account" | "institution" | "class" | "security" | "type";

export const GROUPINGS: { value: GroupBy; label: string }[] = [
  { value: "account", label: "By account" },
  { value: "institution", label: "By institution" },
  { value: "class", label: "By asset class" },
  { value: "type", label: "By security type" },
  { value: "security", label: "By security" },
];

export interface HoldingGroup {
  key: string;
  label: string;
  /** Only an account grouping has one, and only then can a row be edited. */
  account?: Account;
  sub?: string;
  rows: Holding[];
  value: number;
}

/**
 * A provider's lower-cased type, as a reader would write it.
 *
 * Named rather than title-cased, because title case turns "etf" into "Etf".
 * Anything the list does not know gets sentence case, which is right for the
 * ordinary words and no worse than the alternative for the rest.
 */
const TYPE_LABEL: Record<string, string> = {
  etf: "ETF",
  equity: "Equity",
  "mutual fund": "Mutual fund",
  "fixed income": "Fixed income",
  cash: "Cash",
  cryptocurrency: "Cryptocurrency",
  derivative: "Derivative",
  loan: "Loan",
  other: "Other",
};
const typeLabel = (s: string): string =>
  TYPE_LABEL[s.toLowerCase()] ?? (s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());

/**
 * The same positions, cut the way that was asked for.
 *
 * Empty groups are kept only when grouping by account: an account with no
 * positions recorded is a fact worth showing, since its balance still counts
 * toward net worth and somebody has to notice the positions are missing. An
 * asset class nobody holds is not.
 */
export function groupHoldings(
  accounts: readonly Account[],
  holdings: readonly Holding[],
  by: GroupBy,
): HoldingGroup[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));

  if (by === "account") {
    return accounts.map((a) => {
      const rows = holdings.filter((h) => h.accountId === a.id);
      return {
        key: a.id,
        label: a.name,
        account: a,
        sub: a.institution,
        rows,
        value: rows.reduce((s, h) => s + holdingValue(h), 0),
      };
    });
  }

  const of = (h: Holding): { key: string; label: string } => {
    const account = byId.get(h.accountId);
    switch (by) {
      case "institution":
        return { key: account?.institution || "none", label: account?.institution || "No institution" };
      case "class":
        return { key: h.assetClass, label: ASSET_CLASS_LABEL[h.assetClass] ?? h.assetClass };
      case "type":
        // A holding nobody has told us about is its own group rather than
        // being filed under a type it might not be.
        return h.securityType
          ? { key: h.securityType.toLowerCase(), label: typeLabel(h.securityType) }
          : { key: "", label: "Not recorded" };
      default: {
        const sym = h.ticker.trim().toUpperCase();
        return { key: sym || h.name, label: sym || h.name };
      }
    }
  };

  const groups = new Map<string, HoldingGroup>();
  for (const h of holdings) {
    const { key, label } = of(h);
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(h);
      existing.value += holdingValue(h);
    } else {
      groups.set(key, { key, label, rows: [h], value: holdingValue(h) });
    }
  }
  // Biggest first: the question behind every one of these cuts is "where is
  // the money", and an alphabetical answer buries it.
  const out = [...groups.values()].sort((a, b) => b.value - a.value);
  // One security held in three accounts is one row per account otherwise,
  // which is the one grouping where a sub-line earns its place.
  if (by === "security") {
    for (const g of out) {
      const where = new Set(g.rows.map((h) => byId.get(h.accountId)?.name).filter(Boolean));
      g.sub = [...where].join(", ");
    }
  }
  return out;
}

/**
 * What a position's price did over a window, as a fraction.
 *
 * Price, not value: the share count is only known as of today, so a figure
 * built from it and an old price would be what the position *would* have been
 * worth had it always been this size — which is not what anybody means by
 * "how has it done". The proportion is honest either way, and it is what the
 * chart above the table plots.
 *
 * Null when the provider has no reading at one end or the other. A blank is
 * better than a zero, which reads as "went nowhere".
 */
export function periodReturn(
  history: PriceHistory | undefined,
  from: ISODate,
  to: ISODate,
): number | null {
  if (!history || !history.dates.length) return null;
  const open = closeOn(history, from);
  const close = closeOn(history, to);
  if (open === null || close === null || open <= 0) return null;
  return (close - open) / open;
}

/**
 * A group's return, weighted by what each position is worth.
 *
 * Only the rows with a reading count, toward the figure and toward the
 * weights: averaging in a zero for a symbol nobody could price would drag the
 * answer toward nothing for a reason that has nothing to do with the money.
 */
export function groupReturn(
  rows: readonly Holding[],
  histories: Record<string, PriceHistory>,
  from: ISODate,
  to: ISODate,
): number | null {
  let weight = 0;
  let total = 0;
  for (const h of rows) {
    const r = periodReturn(histories[h.ticker.trim().toUpperCase()], from, to);
    if (r === null) continue;
    const w = Math.abs(holdingValue(h));
    if (!w) continue;
    weight += w;
    total += r * w;
  }
  return weight > 0 ? total / weight : null;
}

/** Every symbol on this page worth asking a provider about, capped. */
export function holdingTickers(db: DB, cap: number): string[] {
  const out = new Set<string>();
  for (const h of db.holdings) {
    const t = h.ticker.trim().toUpperCase();
    if (t) out.add(t);
    if (out.size >= cap) break;
  }
  return [...out];
}

/**
 * A position that moved, over some stretch.
 *
 * Price, not value, for the reason `periodReturn` gives: the share count is
 * only known as of today. What is reported is what the security did, which is
 * the question "top movers" asks in every other place it is asked.
 */
export interface Mover {
  ticker: string;
  name: string;
  /** Latest price, in cents per share. */
  price: number;
  /** What the position is worth now, so a tie breaks toward the real money. */
  value: number;
  /** Signed, as a fraction. */
  change: number;
}

/**
 * The biggest movers over a window, by how far they moved either way.
 *
 * Ranked on the size of the move rather than its direction, or a bad week
 * would be reported as a list of the five things that fell least. A reader
 * asking what moved wants the fall at the top of the list, not buried under
 * everything that happened to be green.
 *
 * One row per symbol, however many accounts hold it: the same fund in a 401(k)
 * and an IRA did one thing, not two.
 */
export function topMovers(
  holdings: readonly Holding[],
  histories: Record<string, PriceHistory>,
  from: ISODate,
  to: ISODate,
  limit: number,
): Mover[] {
  const by = new Map<string, Mover>();
  for (const h of holdings) {
    const ticker = h.ticker.trim().toUpperCase();
    if (!ticker) continue;
    const seen = by.get(ticker);
    if (seen) {
      seen.value += holdingValue(h);
      continue;
    }
    const change = periodReturn(histories[ticker], from, to);
    // A symbol with no reading at one end is left out rather than ranked at
    // nought: "did not move" and "nobody could price it" are different, and
    // only one of them belongs in a list of what moved.
    //
    // Nor does one that did not move at all. To the cent over a whole period
    // that is a stable-value fund or a reading that stopped coming, and
    // either way a list of five noughts is not an answer to "what moved".
    if (change === null || change === 0) continue;
    by.set(ticker, { ticker, name: h.name || ticker, price: h.price, value: holdingValue(h), change });
  }
  return [...by.values()]
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || Math.abs(b.value) - Math.abs(a.value))
    .slice(0, limit);
}
