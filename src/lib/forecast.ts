import type { DB, ID, MonthKey } from "../types.js";
import { addMonths, lastMonths, monthOf, thisMonth } from "./date.js";
import { cashFlowSeries } from "./select.js";

/**
 * Where the money is going, decades out.
 *
 * Everything else in this app reports what happened. This is the one place
 * that says what might, and that difference governs every decision in here:
 *
 *   - Every assumption is a named, editable number. None of them is buried in
 *     this file as a constant somebody would have to read code to find.
 *   - The answer is a range, not a figure. A single line through thirty years
 *     of markets is a guess wearing a suit; three lines drawn from three
 *     return rates say the same thing without pretending.
 *   - Today's money by default. "$2.1M in 2056" is a number nobody can feel,
 *     and most of the difference between it and today's balance is inflation
 *     rather than progress.
 *
 * The arithmetic is a month-by-month walk. Not a closed-form compound-interest
 * formula: the moment a forecast has events in it — a house, a job change, a
 * pension starting — the formula stops applying and the walk still works.
 */

/* ── what a plan is made of ───────────────────────────────────────────── */

export type TaxTreatment = "taxable" | "traditional" | "roth";

export interface Assumptions {
  /** Used for every age in here. Nothing else in the app asks for it. */
  birthYear: number;
  retireAge: number;
  /** How far the walk runs. Not a prediction of death; a planning horizon. */
  endAge: number;
  /** Nominal annual return on invested money, before inflation. */
  returnPct: number;
  /** How far either side of it the band is drawn. */
  returnSpreadPct: number;
  inflationPct: number;
  /** How fast pay rises. Level with inflation means flat in real terms. */
  wageGrowthPct: number;
  /** Retirement spending, as a proportion of what is spent now. */
  retirementSpendPct: number;
  /** Effective rate on money taken out of a pre-tax account. */
  taxRatePct: number;
  /** Going in each month that the measured surplus cannot see, like a 401(k)
   *  contribution taken from gross pay before it ever reaches a current
   *  account. */
  monthlyRetirementContribution: number;
  /** Show the answer in today's money rather than in the year's own. */
  realDollars: boolean;
  /** Per liability, because nothing else in the app records either. */
  debts: Record<ID, { apr: number; termMonths: number }>;
}

export type EventKind = "income" | "expense" | "oneOff" | "home";

export interface ForecastEvent {
  id: ID;
  kind: EventKind;
  name: string;
  /** When it starts, or when it happens for a one-off. */
  at: MonthKey;
  /** income/expense: per month, in today's money. oneOff: the lump, signed. */
  amount: number;
  /** income/expense: the age it stops at. Runs to the end without one. */
  untilAge?: number;
  /** home only. */
  home?: { price: number; downPayment: number; apr: number; termMonths: number; monthlyCosts: number };
}

export interface Scenario {
  id: ID;
  name: string;
  assumptions: Assumptions;
  events: ForecastEvent[];
}

export interface ForecastPlan {
  scenarios: Scenario[];
  activeId: ID;
}

/* ── where the walk starts ────────────────────────────────────────────── */

export interface Position {
  /** Current accounts and savings: spent from first, and earns nothing here. */
  cash: number;
  taxable: number;
  traditional: number;
  roth: number;
  /** Property and vehicles. Grown, never drawn on. */
  illiquid: number;
  /** Signed negative, by id so each can amortise on its own terms. */
  debts: { id: ID; balance: number }[];
  /** Take-home pay a month, as the transactions show it. */
  monthlyIncome: number;
  /** Everything going out a month, debt payments included. */
  monthlySpend: number;
}

export interface ForecastPoint {
  month: MonthKey;
  age: number;
  cash: number;
  invested: number;
  illiquid: number;
  debt: number;
  net: number;
  /** True once the walk has stopped counting pay. */
  retired: boolean;
}

export interface ForecastRun {
  points: ForecastPoint[];
  /** Net worth the month retirement starts. */
  atRetirement: number;
  /** The age the invested money and cash run out, if they do. */
  ranOutAt: number | null;
  /** Net worth at the end of the horizon. */
  atEnd: number;
}

/* ── the arithmetic ───────────────────────────────────────────────────── */

/**
 * An annual rate as a monthly one.
 *
 * Compounded, not divided: 12% a year is 0.949% a month, and dividing gives 1%
 * — which is 12.7% a year. Over thirty years that error alone is a fifth of
 * the answer.
 */
export const monthlyRate = (annualPct: number): number =>
  Math.pow(1 + annualPct / 100, 1 / 12) - 1;

/**
 * The same, for borrowing, where the convention is different.
 *
 * A lender quotes an APR and then charges a twelfth of it every month, so 6%
 * on a $300,000 mortgage is the $1,798.65 payment everybody recognises.
 * Compounding it gives $1,768, which is the right answer to a question nobody
 * asked and does not match the statement in the post.
 */
export const debtMonthlyRate = (aprPct: number): number => aprPct / 100 / 12;

/**
 * The level payment that clears a balance over a term.
 *
 * The standard annuity formula, with the zero-rate case split out because the
 * general one divides by zero there rather than saying "balance over months".
 */
export function levelPayment(balance: number, apr: number, months: number): number {
  const owed = Math.abs(balance);
  if (months <= 0) return owed;
  const r = debtMonthlyRate(apr);
  if (r <= 0) return owed / months;
  return (owed * r) / (1 - Math.pow(1 + r, -months));
}

const ageAt = (month: MonthKey, birthYear: number): number =>
  Number(month.slice(0, 4)) - birthYear + (Number(month.slice(5, 7)) - 1) / 12;

/**
 * One pass of the walk, at one return rate.
 *
 * The order inside a month is the order things happen in life: money comes in,
 * bills go out, what is left is saved or taken from savings, and only then
 * does anything grow. Growing first would pay a month's return on money that
 * had not arrived.
 */
export function runForecast(
  start: Position,
  a: Assumptions,
  events: readonly ForecastEvent[],
  returnPct: number,
  from: MonthKey = thisMonth(),
): ForecastRun {
  const r = monthlyRate(returnPct);
  const inflation = monthlyRate(a.inflationPct);
  const wage = monthlyRate(a.wageGrowthPct);
  const tax = Math.min(0.95, Math.max(0, a.taxRatePct / 100));

  let cash = start.cash;
  let taxable = start.taxable;
  let traditional = start.traditional;
  let roth = start.roth;
  let illiquid = start.illiquid;

  // Each debt keeps its own payment, worked out once from the balance and
  // terms it starts with, so paying it off drops that payment out of spending
  // rather than leaving a household paying a mortgage it no longer has.
  const debts = start.debts.map((d) => {
    const terms = a.debts[d.id] ?? { apr: 0, termMonths: 0 };
    return {
      balance: Math.abs(d.balance),
      apr: terms.apr,
      payment: levelPayment(d.balance, terms.apr, terms.termMonths),
      live: Math.abs(d.balance) > 0 && terms.termMonths > 0,
    };
  });

  let income = start.monthlyIncome;
  let spend = start.monthlySpend;
  const months = Math.max(1, Math.round((a.endAge - ageAt(from, a.birthYear)) * 12));
  const retireMonth = Math.max(0, Math.round((a.retireAge - ageAt(from, a.birthYear)) * 12));

  const points: ForecastPoint[] = [];
  let atRetirement = 0;
  let ranOutAt: number | null = null;
  let cut = false;

  for (let i = 0; i <= months; i++) {
    const month = addMonths(from, i);
    const age = ageAt(month, a.birthYear);
    const retired = i >= retireMonth;

    // Pay stops at retirement, and what is spent steps to its retirement
    // level once, rather than every month after.
    if (retired && !cut) { spend *= a.retirementSpendPct / 100; cut = true; }

    let inflow = retired ? 0 : income;
    let outflow = spend;

    for (const e of events) {
      if (e.at > month) continue;
      const over = e.untilAge !== undefined && age >= e.untilAge;
      // In today's money, so a pension named now is worth the same later.
      const grown = e.amount * Math.pow(1 + inflation, i);
      if (e.kind === "income" && !over) inflow += grown;
      if (e.kind === "expense" && !over) outflow += grown;
      // Signed: an inheritance and a wedding are the same event with opposite
      // signs, and both land in cash for the month to spend or sweep away.
      if (e.kind === "oneOff" && e.at === month) cash += grown;
      if (e.kind === "home" && e.home) {
        if (e.at === month) {
          cash -= e.home.downPayment;
          illiquid += e.home.price;
          debts.push({
            balance: e.home.price - e.home.downPayment,
            apr: e.home.apr,
            payment: levelPayment(e.home.price - e.home.downPayment, e.home.apr, e.home.termMonths),
            live: true,
          });
        }
        outflow += e.home.monthlyCosts * Math.pow(1 + inflation, i);
      }
    }

    // Debt payments are already inside measured spending, so only the part
    // that is interest leaves and the rest moves the balance. What is *not*
    // already in there is a payment on a house bought later, which is why the
    // event adds one and this does not.
    for (const d of debts) {
      if (!d.live) continue;
      const interest = d.balance * debtMonthlyRate(d.apr);
      const principal = Math.min(d.balance, Math.max(0, d.payment - interest));
      d.balance -= principal;
      if (d.balance <= 1) {
        d.balance = 0;
        d.live = false;
        // The household stops paying it, so it stops being spent.
        spend = Math.max(0, spend - d.payment);
      }
    }

    // What the month had left over, or had to find. A retirement contribution
    // is not in here: it never reaches a current account, so it is added to
    // the pot below rather than subtracted from a surplus that never saw it.
    const net = inflow - outflow;

    if (net >= 0) {
      cash += net;
      // Anything piling up beyond a float gets invested, or a forecast shows
      // thirty years of savings sitting in a current account earning nothing.
      const float = Math.max(0, spend * 3);
      if (cash > float) { taxable += cash - float; cash = float; }
    } else {
      let owed = -net;
      const fromCash = Math.min(cash, owed);
      cash -= fromCash; owed -= fromCash;
      const fromTaxable = Math.min(taxable, owed);
      taxable -= fromTaxable; owed -= fromTaxable;
      if (owed > 0 && traditional > 0) {
        // Grossed up: taking $1,000 out of a pre-tax account at 22% leaves
        // $780, so $1,282 has to come out to spend $1,000.
        const gross = Math.min(traditional, owed / (1 - tax));
        traditional -= gross;
        owed -= gross * (1 - tax);
      }
      if (owed > 0) {
        const fromRoth = Math.min(roth, owed);
        roth -= fromRoth; owed -= fromRoth;
      }
      if (owed > 0.5 && ranOutAt === null) ranOutAt = Math.round(age * 10) / 10;
    }

    if (!retired && a.monthlyRetirementContribution > 0) {
      traditional += a.monthlyRetirementContribution * Math.pow(1 + inflation, i);
    }

    taxable *= 1 + r;
    traditional *= 1 + r;
    roth *= 1 + r;
    illiquid *= 1 + inflation;
    if (!retired) income *= 1 + wage;
    spend *= 1 + inflation;

    // The `|| 0` is not redundant: negating a sum of nothing gives negative
    // zero, which prints as "-$0" and is not equal to zero under Object.is,
    // so a paid-off debt would fail a test that says it is gone.
    const debt = -debts.reduce((s, d) => s + d.balance, 0) || 0;
    const invested = taxable + traditional + roth;
    // Deflated back to today, so a reader is comparing like with like against
    // the balance on their own dashboard.
    const scale = a.realDollars ? Math.pow(1 + inflation, -i) : 1;
    const point: ForecastPoint = {
      month, age: Math.round(age * 10) / 10,
      cash: Math.round(cash * scale),
      invested: Math.round(invested * scale),
      illiquid: Math.round(illiquid * scale),
      debt: Math.round(debt * scale),
      net: Math.round((cash + invested + illiquid + debt) * scale),
      retired,
    };
    points.push(point);
    if (i === retireMonth) atRetirement = point.net;
  }

  return { points, atRetirement, ranOutAt, atEnd: points[points.length - 1]?.net ?? 0 };
}

/** The same walk at three return rates: the middle one, and the band. */
export function runBand(
  start: Position,
  a: Assumptions,
  events: readonly ForecastEvent[],
  from: MonthKey = thisMonth(),
): { low: ForecastRun; mid: ForecastRun; high: ForecastRun } {
  const spread = Math.max(0, a.returnSpreadPct);
  return {
    low: runForecast(start, a, events, a.returnPct - spread, from),
    mid: runForecast(start, a, events, a.returnPct, from),
    high: runForecast(start, a, events, a.returnPct + spread, from),
  };
}

/**
 * The earliest age the money still lasts to the end of the horizon.
 *
 * Bisected over the same walk rather than solved, for the reason the walk
 * exists at all: with events in the plan there is no formula to solve. Answered
 * at the middle return, because an answer that only holds if markets are kind
 * is not an answer.
 */
export function earliestRetirement(
  start: Position,
  a: Assumptions,
  events: readonly ForecastEvent[],
  from: MonthKey = thisMonth(),
): number | null {
  const worksAt = (age: number): boolean =>
    runForecast(start, { ...a, retireAge: age }, events, a.returnPct, from).ranOutAt === null;

  const now = Math.ceil(ageAt(from, a.birthYear));
  if (!worksAt(a.endAge)) return null;
  if (worksAt(now)) return now;

  let lo = now;
  let hi = a.endAge;
  // Whole years: a forecast this soft has no business reporting a month.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (worksAt(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

/* ── reading a starting position off the document ─────────────────────── */

/** Which pot an account's money is in, when nobody has said. */
export function defaultTreatment(type: string, name: string): TaxTreatment | null {
  if (type === "retirement") return /roth/i.test(name) ? "roth" : "traditional";
  if (type === "investment" || type === "crypto") return "taxable";
  return null;
}

const CASH = new Set(["checking", "savings"]);
const ILLIQUID = new Set(["real_estate", "vehicle", "other_asset"]);
const LIABILITY = new Set(["credit", "loan", "mortgage", "other_liability"]);

/** What a liability costs and how long it has left, when nobody has said. */
export const DEBT_DEFAULTS: Record<string, { apr: number; termMonths: number }> = {
  mortgage: { apr: 6.5, termMonths: 300 },
  loan: { apr: 7, termMonths: 48 },
  credit: { apr: 22, termMonths: 24 },
  other_liability: { apr: 6, termMonths: 60 },
};

/** How many months of real transactions the flows are measured over. */
export const FLOW_MONTHS = 12;

/**
 * What comes in and what goes out in an ordinary month.
 *
 * Measured rather than asked for, because a figure somebody types in is a
 * figure about the month they typed it in. Twelve months, and the month in
 * progress left out: a forecast built on the third of the month would read
 * three days of spending as a whole one and conclude the household saves
 * ninety percent of its pay.
 *
 * Averaged over the window rather than taken from the last complete month,
 * so an annual insurance premium counts for a twelfth of itself instead of
 * either everything or nothing.
 */
export function measuredFlows(db: DB, now: MonthKey = thisMonth()): { income: number; spend: number } {
  const months = lastMonths(FLOW_MONTHS, addMonths(now, -1));
  const flows = cashFlowSeries(db, months);
  // Only the months that actually carry anything: a document holding three
  // months of history would otherwise have its flows divided by twelve.
  const live = flows.filter((f) => f.income !== 0 || f.expense !== 0);
  if (!live.length) return { income: 0, spend: 0 };
  const total = live.reduce((s, f) => ({ income: s.income + f.income, expense: s.expense + f.expense }), { income: 0, expense: 0 });
  return {
    income: Math.round(total.income / live.length),
    spend: Math.round(total.expense / live.length),
  };
}

/**
 * Today's balances, as the walk needs them, with the flows handed in.
 *
 * Every account the dashboard counts, sorted into the five things the walk
 * can tell apart: money that is spent from, money that grows and is taxed on
 * the way out, money that grows and is not, things that are worth something
 * but are not savings, and things that are owed.
 */
export function startingPosition(
  db: DB,
  monthlyIncome: number,
  monthlySpend: number,
): Position {
  const pos: Position = {
    cash: 0, taxable: 0, traditional: 0, roth: 0, illiquid: 0,
    debts: [], monthlyIncome, monthlySpend,
  };
  for (const acc of db.accounts) {
    if (acc.hidden || acc.closedAt || !acc.includeInNetWorth) continue;
    if (LIABILITY.has(acc.type)) {
      if (acc.balance !== 0) pos.debts.push({ id: acc.id, balance: acc.balance });
      continue;
    }
    if (CASH.has(acc.type)) { pos.cash += acc.balance; continue; }
    if (ILLIQUID.has(acc.type)) { pos.illiquid += acc.balance; continue; }
    const where = acc.taxTreatment ?? defaultTreatment(acc.type, acc.name);
    if (where === "traditional") pos.traditional += acc.balance;
    else if (where === "roth") pos.roth += acc.balance;
    else if (where === "taxable") pos.taxable += acc.balance;
    else pos.cash += acc.balance;
  }
  return pos;
}

/* ── a plan to start from ─────────────────────────────────────────────── */

export const DEFAULT_ASSUMPTIONS: Omit<Assumptions, "birthYear" | "debts"> = {
  retireAge: 65,
  endAge: 95,
  returnPct: 6,
  returnSpreadPct: 2,
  inflationPct: 3,
  wageGrowthPct: 3,
  retirementSpendPct: 85,
  taxRatePct: 22,
  monthlyRetirementContribution: 0,
  realDollars: true,
};

/**
 * The plan's terms, with defaults filled in for any liability it has not seen.
 *
 * A plan is seeded from the accounts as they stood the day it was made, and a
 * mortgage taken out afterwards would otherwise sit in the walk at nought
 * percent over nought months - which is a debt that never amortises and never
 * costs anything, the one answer that is certainly wrong. Returns the same
 * object when there is nothing to add, so it is safe in a memo.
 */
export function withDebtDefaults(a: Assumptions, db: DB): Assumptions {
  const debts = { ...a.debts };
  let added = false;
  for (const acc of db.accounts) {
    if (!LIABILITY.has(acc.type) || acc.hidden || acc.closedAt) continue;
    if (debts[acc.id]) continue;
    debts[acc.id] = DEBT_DEFAULTS[acc.type] ?? DEBT_DEFAULTS.other_liability;
    added = true;
  }
  return added ? { ...a, debts } : a;
}

/** A plan for a document that has never had one. */
export function blankPlan(db: DB, now: MonthKey = thisMonth()): ForecastPlan {
  const debts: Assumptions["debts"] = {};
  for (const acc of db.accounts) {
    if (!LIABILITY.has(acc.type) || acc.hidden || acc.closedAt) continue;
    debts[acc.id] = DEBT_DEFAULTS[acc.type] ?? DEBT_DEFAULTS.other_liability;
  }
  return {
    activeId: "sc_base",
    scenarios: [{
      id: "sc_base",
      name: "Base",
      assumptions: { ...DEFAULT_ASSUMPTIONS, birthYear: Number(now.slice(0, 4)) - 40, debts },
      events: [],
    }],
  };
}

/** The scenario being shown, or the first one, or nothing. */
export const activeScenario = (plan: ForecastPlan | undefined): Scenario | undefined =>
  plan?.scenarios.find((s) => s.id === plan.activeId) ?? plan?.scenarios[0];

/** The month an age falls in, for placing a marker on the timeline. */
export const monthAtAge = (birthYear: number, age: number): MonthKey =>
  monthOf(`${Math.round(birthYear + Math.floor(age))}-${String(Math.round((age % 1) * 12) + 1).padStart(2, "0")}-01`);
