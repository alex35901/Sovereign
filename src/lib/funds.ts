import type { AssetClass, Holding } from "../types.js";
import { holdingValue } from "./select.js";

/**
 * What a fund is actually made of.
 *
 * A portfolio of four tickers has four rows and tells you nothing about
 * diversification, because three of them are funds and a fund is a portfolio
 * of its own. VT tagged "US Stocks" is forty percent wrong; a target-date fund
 * tagged anything at all is mostly wrong. Until the funds are opened up,
 * "how much of this is in bonds" is a question the allocation chart cannot
 * answer, and it is the only question most people are asking of it.
 *
 * Three things are deliberately true of this table:
 *
 *   - It is honest about being a table. There is no free data feed that
 *     decomposes funds, so these are published allocations read off the
 *     issuers, rounded, and dated. A stale weight is better than a confident
 *     wrong one, so the screen says how much of the portfolio it could open up
 *     and how much it is taking at face value.
 *   - A fund it does not know is not a failure. It counts as recorded, which
 *     is exactly what happens today, so adding this cannot make the chart
 *     worse than it already is.
 *   - It never guesses from the name. "Vanguard Total Bond" parsing to bonds
 *     works until somebody holds "Total Bond Market Hedge Fund LP", and a
 *     wrong answer here is invisible: it looks exactly like a right one.
 */

/** When these weights were read off the issuers' own published allocations. */
export const MIX_AS_OF = "2026-06";

type Mix = Partial<Record<AssetClass, number>>;

/**
 * Published allocations, as fractions, by ticker.
 *
 * Rounded to whole percent, which is finer than the question deserves: these
 * drift daily and nobody is rebalancing off a third decimal place. A
 * target-date fund glides, so its weights are right for the year above and
 * wrong by a little every year after - which is why the date is published
 * beside them rather than buried here.
 */
export const FUND_MIX: Record<string, Mix> = {
  /* ── broad US equity: what they say on the tin ──────────────────── */
  VTI: { us_equity: 1 }, ITOT: { us_equity: 1 }, SCHB: { us_equity: 1 },
  VOO: { us_equity: 1 }, SPY: { us_equity: 1 }, IVV: { us_equity: 1 },
  VUG: { us_equity: 1 }, VTV: { us_equity: 1 }, VB: { us_equity: 1 },
  QQQ: { us_equity: 1 }, VIG: { us_equity: 1 }, SCHD: { us_equity: 1 },
  FXAIX: { us_equity: 1 }, FSKAX: { us_equity: 1 }, FZROX: { us_equity: 1 },
  VTSAX: { us_equity: 1 }, VFIAX: { us_equity: 1 }, SWTSX: { us_equity: 1 },

  /* ── international ─────────────────────────────────────────────── */
  VXUS: { intl_equity: 1 }, IXUS: { intl_equity: 1 }, VEU: { intl_equity: 1 },
  VEA: { intl_equity: 1 }, VWO: { intl_equity: 1 }, IEFA: { intl_equity: 1 },
  VTIAX: { intl_equity: 1 }, FTIHX: { intl_equity: 1 }, FZILX: { intl_equity: 1 },

  /* ── bonds ─────────────────────────────────────────────────────── */
  BND: { bond: 1 }, AGG: { bond: 1 }, BNDX: { bond: 1 }, BIV: { bond: 1 },
  VCIT: { bond: 1 }, TLT: { bond: 1 }, SHY: { bond: 1 }, TIP: { bond: 1 },
  VBTLX: { bond: 1 }, FXNAX: { bond: 1 }, MUB: { bond: 1 }, HYG: { bond: 1 },
  BNDW: { bond: 1 },

  /* ── the ones a single tag gets plainly wrong ───────────────────── */
  // Total world: the whole reason this file exists.
  VT: { us_equity: 0.63, intl_equity: 0.37 },
  ACWI: { us_equity: 0.65, intl_equity: 0.35 },
  VTWAX: { us_equity: 0.63, intl_equity: 0.37 },

  // Vanguard LifeStrategy and the iShares core allocation funds: a stock and
  // bond split in one ticker, which is exactly what a pie chart cannot show.
  VASIX: { us_equity: 0.12, intl_equity: 0.08, bond: 0.8 },
  VSCGX: { us_equity: 0.24, intl_equity: 0.16, bond: 0.6 },
  VSMGX: { us_equity: 0.36, intl_equity: 0.24, bond: 0.4 },
  VASGX: { us_equity: 0.48, intl_equity: 0.32, bond: 0.2 },
  AOK: { us_equity: 0.18, intl_equity: 0.12, bond: 0.7 },
  AOM: { us_equity: 0.24, intl_equity: 0.16, bond: 0.6 },
  AOR: { us_equity: 0.36, intl_equity: 0.24, bond: 0.4 },
  AOA: { us_equity: 0.48, intl_equity: 0.32, bond: 0.2 },

  // Vanguard target retirement, which glide toward bonds as they approach.
  VTINX: { us_equity: 0.18, intl_equity: 0.12, bond: 0.7 },
  VTWNX: { us_equity: 0.2, intl_equity: 0.14, bond: 0.66 },
  VTTVX: { us_equity: 0.27, intl_equity: 0.18, bond: 0.55 },
  VTHRX: { us_equity: 0.35, intl_equity: 0.24, bond: 0.41 },
  VTTHX: { us_equity: 0.42, intl_equity: 0.29, bond: 0.29 },
  VFORX: { us_equity: 0.5, intl_equity: 0.33, bond: 0.17 },
  VTIVX: { us_equity: 0.54, intl_equity: 0.36, bond: 0.1 },
  VFIFX: { us_equity: 0.54, intl_equity: 0.36, bond: 0.1 },
  VFFVX: { us_equity: 0.54, intl_equity: 0.36, bond: 0.1 },
  VLXVX: { us_equity: 0.54, intl_equity: 0.36, bond: 0.1 },

  /* ── property, metals and money ─────────────────────────────────── */
  VNQ: { real_estate: 1 }, SCHH: { real_estate: 1 }, VGSLX: { real_estate: 1 },
  GLD: { other: 1 }, IAU: { other: 1 },
  VMFXX: { cash: 1 }, SPAXX: { cash: 1 }, SWVXX: { cash: 1 }, SGOV: { cash: 1 },
  BIL: { cash: 1 },
};

/** The published mix for a symbol, or nothing if this table has never met it. */
export const mixFor = (ticker: string): Mix | undefined =>
  FUND_MIX[ticker.trim().toUpperCase()];

export interface ClassSlice {
  key: AssetClass;
  value: number;
}

export interface LookThrough {
  slices: ClassSlice[];
  /** What was opened up, and what was counted as it was recorded. */
  seen: number;
  faceValue: number;
  /** Positions this table could not open, biggest first, for saying so. */
  unknown: { ticker: string; name: string; value: number }[];
}

/**
 * The portfolio split by what it is really made of.
 *
 * A position the table knows is spread across its published weights. One it
 * does not is counted whole under whatever it was recorded as, which is what
 * the chart does today - so a portfolio of nothing but obscure funds draws
 * exactly the chart it drew before, rather than an empty one.
 *
 * Weights are applied to value, not to share counts, because a fund's
 * allocation is a proportion of what it is worth.
 */
export function lookThrough(holdings: readonly Holding[]): LookThrough {
  const by = new Map<AssetClass, number>();
  const add = (k: AssetClass, v: number) => by.set(k, (by.get(k) ?? 0) + v);
  const unknown: LookThrough["unknown"] = [];
  let seen = 0;
  let faceValue = 0;

  for (const h of holdings) {
    const value = holdingValue(h);
    if (!value) continue;
    const mix = mixFor(h.ticker);
    if (!mix) {
      add(h.assetClass, value);
      faceValue += value;
      unknown.push({ ticker: h.ticker.trim().toUpperCase() || h.name, name: h.name, value });
      continue;
    }
    seen += value;
    // Normalised, so a table entry that does not quite add to one cannot
    // quietly lose or invent money.
    const total = Object.values(mix).reduce((n, w) => n + (w ?? 0), 0) || 1;
    for (const [k, w] of Object.entries(mix)) {
      if (!w) continue;
      add(k as AssetClass, (value * w) / total);
    }
  }

  unknown.sort((a, b) => b.value - a.value);
  return {
    slices: [...by.entries()]
      .map(([key, value]) => ({ key, value: Math.round(value) }))
      .filter((x) => x.value !== 0)
      .sort((a, b) => b.value - a.value),
    seen: Math.round(seen),
    faceValue: Math.round(faceValue),
    unknown,
  };
}
