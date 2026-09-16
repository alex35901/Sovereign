import type { Account, DB, EstateRecord, ID, ISODate, MonthKey } from "../types.js";
import { longDate, thisMonth, today } from "./date.js";
import { ACCOUNT_TYPE_LABEL, recurringList } from "./select.js";
import type { Assumptions, ForecastEvent, ForecastRun, Position } from "./forecast.js";
import { levelPayment, runForecast, withDebtDefaults } from "./forecast.js";

/**
 * What happens to the people who are left.
 *
 * The forecast answers "will I have enough". This answers the question a
 * parent of small children actually lies awake asking, which is a different
 * one: if I do not come home, are they all right, and if not, by how much.
 *
 * It is the same walk. Nothing here re-implements the arithmetic; it builds a
 * different starting position and a different set of assumptions and hands
 * both to `runForecast`. That matters more than it looks: the survivor case is
 * the one nobody will ever check by hand, so it had better be the code that is
 * already checked.
 *
 * Two deliberate conservatisms, because the cost of being wrong is not
 * symmetrical here:
 *
 *   - Spending does not fall by default. A household of four minus one adult
 *     does not spend a quarter less, and a surviving parent may be paying for
 *     childcare that two of them used to do between them.
 *   - The payout is money, not magic. Clearing a mortgage with it spends it,
 *     and the walk goes on from what is left.
 */

export interface Survivorship {
  /** Take-home pay a month that would stop. */
  incomeLost: number;
  /** What the household would spend, against what it spends now. */
  spendPct: number;
  /** Life cover and other death benefits, paid as a lump in the first month. */
  cover: number;
  /** Liabilities the survivor would clear out of that lump, mortgage first. */
  clears: ID[];
  /** The survivor's own year of birth, since the money has to last for them. */
  survivorBirthYear: number;
  /** And the age it has to last to. */
  survivorEndAge: number;
}

export const DEFAULT_SURVIVORSHIP: Omit<Survivorship, "survivorBirthYear"> = {
  incomeLost: 0,
  // Not 85, and not a guess dressed up as a default: until somebody says
  // otherwise, the household costs what it costs.
  spendPct: 100,
  cover: 0,
  clears: [],
  survivorEndAge: 95,
};

/**
 * The starting position as it would be the month after.
 *
 * The payout lands in cash, and anything being cleared is paid for out of it,
 * whole debts only: a part-paid mortgage is a different loan on different
 * terms, and pretending otherwise would put a payment in the walk that no
 * lender would offer. Each debt that goes also takes its payment out of
 * spending, because that payment is inside the measured figure.
 */
export function survivorPosition(start: Position, a: Assumptions, s: Survivorship): Position {
  let cash = start.cash + s.cover;
  let spend = Math.round((start.monthlySpend * s.spendPct) / 100);
  const debts: Position["debts"] = [];

  for (const d of start.debts) {
    const owed = Math.abs(d.balance);
    if (s.clears.includes(d.id) && owed <= cash) {
      cash -= owed;
      const terms = a.debts[d.id];
      if (terms) spend = Math.max(0, spend - levelPayment(d.balance, terms.apr, terms.termMonths));
      continue;
    }
    debts.push(d);
  }

  return {
    ...start,
    cash,
    debts,
    // Whatever pay is left is the survivor's own, and it carries on.
    monthlyIncome: Math.max(0, start.monthlyIncome - s.incomeLost),
    monthlySpend: Math.round(spend),
  };
}

/**
 * The plan, told whose life it is now measuring.
 *
 * The survivor's birth year replaces the subject's, which silently re-points
 * every age in the assumptions at them: `retireAge` becomes the age *they*
 * stop working, and the horizon becomes theirs. That is the right reading -
 * the person this plan is now about is the one still here.
 */
export function survivorAssumptions(a: Assumptions, s: Survivorship): Assumptions {
  return { ...a, birthYear: s.survivorBirthYear, endAge: s.survivorEndAge };
}

/** The walk, as the survivor would live it, at a cover of `cover`. */
export function runSurvivor(
  start: Position,
  a: Assumptions,
  events: readonly ForecastEvent[],
  s: Survivorship,
  from: MonthKey = thisMonth(),
): ForecastRun {
  return runForecast(
    survivorPosition(start, a, s),
    survivorAssumptions(a, s),
    events,
    a.returnPct,
    from,
  );
}

/** Cover is sold in round numbers, so an answer of $1,237,412 is noise. */
export const COVER_STEP = 25_000_00;

/**
 * More cover than anybody is going to be sold.
 *
 * A named ceiling rather than a search that doubles until something works:
 * the point of the ceiling is to mean something when it is hit. Past a hundred
 * million the answer to "how much cover would it take" is not a policy, it is
 * that the plan spends more than any payout can carry, and saying so is more
 * use than a number nobody could buy.
 */
export const COVER_CEILING = 100_000_000_00;

/**
 * The smallest cover that carries them all the way, in what a policy is
 * actually sold in.
 *
 * Bisected over the same walk rather than solved, for the reason the walk
 * exists: with events in the plan there is no formula. Null when even the
 * ceiling is not enough, which is not a failure to report.
 */
export function coverNeeded(
  start: Position,
  a: Assumptions,
  events: readonly ForecastEvent[],
  s: Survivorship,
  from: MonthKey = thisMonth(),
): number | null {
  const lasts = (cover: number): boolean =>
    runSurvivor(start, a, events, { ...s, cover }, from).ranOutAt === null;

  if (lasts(0)) return 0;
  if (!lasts(COVER_CEILING)) return null;

  // Whole steps throughout, so every amount tried is one that could be bought
  // and the answer needs no rounding at the end - which would otherwise round
  // to a figure the walk had never actually been run at.
  let lo = 0;
  let hi = Math.ceil(COVER_CEILING / COVER_STEP);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (lasts(mid * COVER_STEP)) hi = mid; else lo = mid;
  }
  return hi * COVER_STEP;
}

/** A blank survivorship for a document that has never had one. */
export function blankSurvivorship(db: DB, a: Assumptions, income: number): Survivorship {
  const terms = withDebtDefaults(a, db);
  return {
    ...DEFAULT_SURVIVORSHIP,
    // The whole of it, until somebody says which part was theirs. A household
    // where both work will correct this in one edit; one where only one does
    // gets the right answer without touching anything.
    incomeLost: income,
    survivorBirthYear: a.birthYear,
    survivorEndAge: a.endAge,
    // A mortgage is what people picture being cleared, and it is the one debt
    // whose payment is large enough for clearing it to change the answer.
    clears: db.accounts.filter((x) => x.type === "mortgage" && !x.hidden && !x.closedAt && terms.debts[x.id])
      .map((x) => x.id),
  };
}

/* ── what a family would need to find ─────────────────────────────────── */

/**
 * One line of the summary, in the terms somebody sorting out an estate needs.
 *
 * Not a balance row. An executor's first question is never "how much" but
 * "does this exist, who holds it, and who does it go to" - so the money is
 * the last column rather than the point.
 */
export interface EstateLine {
  key: string;
  name: string;
  /** Institution and kind, and the last four when the provider gives them. */
  detail: string;
  amount: number;
  ownership?: string;
  beneficiary?: string;
  note?: string;
}

export interface EstateSection {
  key: string;
  title: string;
  /** Why this section is here, for somebody who has never seen the app. */
  note?: string;
  lines: EstateLine[];
  total?: number;
}

const OWNERSHIP_LABEL: Record<string, string> = {
  sole: "Sole",
  joint: "Joint",
  trust: "In trust",
};

const ASSET_ORDER = ["checking", "savings", "investment", "retirement", "crypto"];

/** Institution, kind, and the last four digits when there are any. */
const detailOf = (acc: Account, kind: string): string =>
  [acc.institution, kind, acc.mask ? `····${acc.mask}` : ""].filter(Boolean).join(" · ");

/**
 * The parts of the summary the app already knows, without being told.
 *
 * Only those. Insurance, contacts and where the papers are can only come from
 * a person, so they are edited on the screen and printed from there; putting
 * them through here as well was how "Insurance" came to appear on the page
 * twice. The boundary is worth keeping: everything this function returns is
 * derived, so it is always current, and nothing in it can go stale because
 * somebody forgot to come back and update it.
 *
 * Hidden and closed accounts are left out, for the same reason they are left
 * out of net worth: they are not there any more. `includeInNetWorth` is *not*
 * a filter here though, and that difference is the whole point of this being
 * its own function - an account somebody excluded from their net worth chart
 * because it skewed the line is still an account that exists, still has money
 * in it, and still has to be found.
 */
export function estateSummary(db: DB, now: ISODate = today()): EstateSection[] {
  const live = db.accounts.filter((a) => !a.hidden && !a.closedAt);
  const line = (acc: Account): EstateLine => ({
    key: acc.id,
    name: acc.name,
    detail: detailOf(acc, ACCOUNT_TYPE_LABEL[acc.type] ?? acc.type),
    amount: acc.balance,
    ownership: acc.estate?.ownership ? OWNERSHIP_LABEL[acc.estate.ownership] : undefined,
    beneficiary: acc.estate?.beneficiary,
    note: acc.estate?.note,
  });

  const pick = (types: readonly string[]): EstateLine[] =>
    types.flatMap((t) => live.filter((a) => a.type === t)).map(line);

  const assets = pick(ASSET_ORDER);
  const property = pick(["real_estate", "vehicle", "other_asset"]);
  const owed = pick(["mortgage", "loan", "credit", "other_liability"]);

  /**
   * The bills that will keep being taken.
   *
   * This is the section nobody thinks of and everybody needs. A card keeps
   * working for months after somebody dies, and the subscriptions come out of
   * it the whole time. Nothing else in this summary could be assembled by a
   * solicitor from a filing cabinet; this one exists only because the app has
   * been watching the transactions.
   */
  const charging: EstateLine[] = recurringList(db)
    // Not db.recurring, which for most documents is empty: a recurring bill is
    // worked out from the transactions rather than entered, and only the ones
    // somebody has edited by hand are stored. Reading the raw list would leave
    // the one section here nobody else could have written blank.
    .filter((r) => r.kind !== "income")
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .map((r) => {
      const acc = live.find((a) => a.id === r.accountId);
      return {
        key: r.id,
        name: r.merchant,
        detail: [r.cadence, acc ? `from ${acc.name}` : ""].filter(Boolean).join(" · "),
        amount: -Math.abs(r.amount),
        note: r.kind === "subscription" ? "Subscription" : undefined,
      };
    });

  const sum = (xs: EstateLine[]): number => xs.reduce((n, x) => n + x.amount, 0);

  const sections: EstateSection[] = [
    {
      key: "assets",
      title: "Accounts and savings",
      note: "Every account open as of " + longDate(now) + ". A joint account passes to the other holder; a named beneficiary is followed ahead of anything a will says.",
      lines: assets,
      total: sum(assets),
    },
    { key: "property", title: "Property and vehicles", lines: property, total: sum(property) },
    {
      key: "owed",
      title: "What is owed",
      note: "These do not disappear. Most are settled out of the estate before anything is distributed.",
      lines: owed,
      total: sum(owed),
    },
    {
      key: "charging",
      title: "Things that will keep charging",
      note: "Cards and direct debits keep working long after they should. These are what to cancel first.",
      lines: charging,
      total: sum(charging),
    },
  ];

  // An empty section is a section that says nothing. The exception is what is
  // owed: "there are no debts" is worth reading in its own right.
  return sections.filter((s) => s.lines.length || s.key === "owed");
}

/** Life cover in force, which is what the survivor forecast pays in. */
export const lifeCover = (db: DB): number =>
  (db.estate?.policies ?? []).filter((p) => p.kind === "life").reduce((n, p) => n + p.coverage, 0);

/** A blank record for a document that has never had one. */
export const blankEstate = (): EstateRecord =>
  ({ policies: [], contacts: [], documents: [] });
