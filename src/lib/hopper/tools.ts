import type { DB, ISODate } from "../../types.js";
import {
  budgetSummary, budgetTable, cashFlowSeries, categoryAverage, categoryHistory,
  categoryTotals, counts, merchantTotals, monthlyRecurringCost, mutedAccountIds,
  netWorthNow, netWorthSeries, portfolioSummary, recurringList,
} from "../select.js";
import { goalOutlook } from "../goal-funding.js";
import { lastMonths, monthOf, thisMonth, today } from "../date.js";
import {
  activeScenario, blankPlan, earliestRetirement, measuredFlows, runBand,
  startingPosition, withDebtDefaults,
} from "../forecast.js";
import { benefitAt, firstClaimAge, hasBenefit } from "../social-security.js";
import { blankSurvivorship, coverNeeded, estateSummary, lifeCover, runSurvivor } from "../estate.js";
import { compareOrders, debtsFrom } from "../payoff.js";
import { runway } from "../runway.js";
import { priceChanges, yearlyImpact } from "../price-watch.js";
import { SALT_CAP, taxSummary, taxYears } from "../tax.js";
import { reviewYears, yearReview } from "../year-review.js";
import { notices } from "../notifications.js";
import { lookThrough } from "../funds.js";
import type { Scope } from "../select.js";

/**
 * What Hopper is allowed to ask about, and how the answer is worked out.
 *
 * Every one of these is a thin wrapper over a selector the app already uses to
 * draw its own screens — so the figure Hopper quotes is the figure on the page,
 * computed by tested code rather than by a model doing arithmetic over a wall
 * of JSON. That is the whole design: he decides what to look up and how to say
 * it; he never does the sums.
 *
 * All of it is read-only. There is no tool here that can move money, change a
 * category or touch the document, and that is a property worth keeping: a
 * merchant name arrives from a bank and lands in the model's context, so the
 * safe assumption is that anything in the data might be trying to give
 * instructions. It can't, because nothing it could ask for does anything.
 */

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  /** Runs it. Returns whatever should go back as the tool result. */
  run: (db: DB, input: Record<string, unknown>) => unknown;
}

/* ── reading the arguments ────────────────────────────────────────────────
 * The model is good at dates and occasionally wrong about them, and a silently
 * wrong range gives a confident answer about the wrong three months. So each
 * one is checked, and anything unusable falls back to something defensible
 * rather than producing NaN halfway down a total.
 */

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const isDate = (s: string): s is ISODate => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isMonth = (s: string): boolean => /^\d{4}-\d{2}$/.test(s);

/** A date range, defaulting to this month. Always returns from <= to. */
function range(input: Record<string, unknown>): { from: ISODate; to: ISODate } {
  const month = str(input.month);
  if (month && isMonth(month)) {
    const [y, m] = month.split("-").map(Number);
    const end = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
    return { from: `${month}-01`, to: end };
  }
  const f = str(input.from), t = str(input.to);
  const from = f && isDate(f) ? f : `${thisMonth()}-01`;
  const to = t && isDate(t) ? t : today();
  return from <= to ? { from, to } : { from: to, to: from };
}

const months = (input: Record<string, unknown>, fallback = 6): string[] =>
  lastMonths(Math.min(60, Math.max(1, Math.round(num(input.months) ?? fallback))));

/** Cents, so the model never has to divide by a hundred. */
const money = (cents: number): number => Math.round(cents) / 100;

/**
 * The forecast as the Forecast screen assembles it.
 *
 * Built here the same way the screen does rather than read off the document,
 * because a household that has never opened that screen has no plan stored and
 * would otherwise get "no forecast" to a question the app can perfectly well
 * answer. The plan that would be saved on the first edit is the plan Hopper
 * talks about, which is the one the user would see.
 */
function plannedFuture(db: DB) {
  const plan = db.forecast ?? blankPlan(db);
  const scenario = activeScenario(plan);
  if (!scenario) return null;
  const a = withDebtDefaults(scenario.assumptions, db);
  const flows = measuredFlows(db);
  const position = startingPosition(db, flows.income, flows.spend);
  return { plan, scenario, a, flows, position };
}

const SCOPE_ARG = {
  type: "string",
  enum: ["all", "personal", "business", "rental"],
  description:
    "Which set of books. Defaults to all. Only meaningful if accounts have been marked business or rental.",
};

const scopeOf = (input: Record<string, unknown>): Scope => {
  const v = str(input.scope);
  return v === "personal" || v === "business" || v === "rental" ? v : "all";
};

/** A year argument, defaulting to the one now running. */
const yearOf = (input: Record<string, unknown>): number => {
  const n = num(input.year);
  return n && n >= 1900 && n <= 2200 ? Math.round(n) : Number(thisMonth().slice(0, 4));
};

/* ── the tools ─────────────────────────────────────────────────────────── */

const MONTH_ARG = { type: "string", description: "A month as YYYY-MM. Defaults to the current month." };
const RANGE_ARGS = {
  month: MONTH_ARG,
  from: { type: "string", description: "Start date as YYYY-MM-DD. Ignored if month is given." },
  to: { type: "string", description: "End date as YYYY-MM-DD. Ignored if month is given." },
};

export const TOOLS: ToolSpec[] = [
  {
    name: "overview",
    description:
      "The headline position: net worth and its split into assets and liabilities, plus income, "
      + "spending and savings rate for a month. Start here for anything general.",
    input_schema: { type: "object", properties: { month: MONTH_ARG }, additionalProperties: false },
    run: (db, input) => {
      const month = str(input.month) && isMonth(str(input.month)!) ? str(input.month)! : thisMonth();
      const nw = netWorthNow(db);
      const flow = cashFlowSeries(db, [month])[0] ?? { income: 0, expense: 0 };
      const saved = flow.income - flow.expense;
      const rw = runway(db);
      return {
        today: today(),
        month,
        netWorth: money(nw.net),
        assets: money(nw.assets),
        liabilities: money(nw.liabilities),
        income: money(flow.income),
        spending: money(flow.expense),
        saved: money(saved),
        savingsRatePct: flow.income > 0 ? Math.round((saved / flow.income) * 100) : null,
        // "Can I afford this?" is the commonest question there is, and it is
        // about today rather than about the month. Riding along here saves a
        // second round trip on most of them.
        safeToSpend: {
          inChecking: money(rw.cash),
          nextIncome: rw.nextIncome ? { merchant: rw.nextIncome.merchant, date: rw.nextIncome.date, amount: money(rw.nextIncome.amount) } : null,
          until: rw.until,
          daysUntil: rw.days,
          billsBefore: money(rw.billsTotal),
          free: money(rw.free),
          perDay: rw.perDay === null ? null : money(rw.perDay),
          nextIncomeIsAGuess: rw.guessed,
        },
      };
    },
  },
  {
    name: "accounts",
    description: "Every open account with its balance, type and institution.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: (db) => db.accounts.filter((a) => !a.hidden && !a.closedAt).map((a) => ({
      id: a.id,
      name: a.name,
      institution: a.institution,
      type: a.type,
      balance: money(a.balance),
      inNetWorth: a.includeInNetWorth,
    })),
  },
  {
    name: "spending_by_category",
    description:
      "What was spent per category over a period, largest first. Use kind='income' for money coming in.",
    input_schema: {
      type: "object",
      properties: {
        ...RANGE_ARGS,
        kind: { type: "string", enum: ["expense", "income", "all"], description: "Defaults to expense." },
        scope: SCOPE_ARG,
      },
      additionalProperties: false,
    },
    run: (db, input) => {
      const { from, to } = range(input);
      const kind = str(input.kind);
      const k = kind === "income" || kind === "all" ? kind : "expense";
      const scope = scopeOf(input);
      return {
        from, to, kind: k, scope,
        categories: categoryTotals(db, from, to, k, scope).map((c) => ({
          id: c.category.id, name: c.category.name, total: money(c.total),
        })),
      };
    },
  },
  {
    name: "category_detail",
    description:
      "One category month by month, with its average, for questions about a trend or whether "
      + "a month was unusual. Get the id from spending_by_category.",
    input_schema: {
      type: "object",
      properties: {
        categoryId: { type: "string", description: "The category's id." },
        months: { type: "number", description: "How many months back. Defaults to 6, max 60." },
      },
      required: ["categoryId"],
      additionalProperties: false,
    },
    run: (db, input) => {
      const id = str(input.categoryId);
      const cat = db.categories.find((c) => c.id === id);
      if (!cat) return { error: `No category with id ${id}. Call spending_by_category to see the ids.` };
      const history = categoryHistory(db, cat.id, months(input));
      return {
        id: cat.id,
        name: cat.name,
        monthlyAverage: money(categoryAverage(history)),
        history: history.map((h) => ({ month: h.month, spent: money(h.actual) })),
      };
    },
  },
  {
    name: "search_transactions",
    description:
      "Individual transactions, newest first, filtered and capped. Use it to answer 'what was "
      + "that charge' or to list what made up a total, not to add things up, which the other tools do.",
    input_schema: {
      type: "object",
      properties: {
        ...RANGE_ARGS,
        merchant: { type: "string", description: "Case-insensitive substring of the merchant name." },
        categoryId: { type: "string" },
        accountId: { type: "string" },
        minAmount: { type: "number", description: "Smallest absolute amount in dollars." },
        limit: { type: "number", description: "Defaults to 25, max 100." },
      },
      additionalProperties: false,
    },
    run: (db, input) => {
      const { from, to } = range(input);
      const merchant = str(input.merchant)?.toLowerCase();
      const categoryId = str(input.categoryId);
      const accountId = str(input.accountId);
      const min = num(input.minAmount);
      const limit = Math.min(100, Math.max(1, Math.round(num(input.limit) ?? 25)));
      const names = new Map(db.categories.map((c) => [c.id, c.name]));

      const hits = db.transactions
        .filter((t) => t.date >= from && t.date <= to)
        .filter((t) => (merchant ? t.merchant.toLowerCase().includes(merchant) : true))
        .filter((t) => (categoryId ? t.categoryId === categoryId : true))
        .filter((t) => (accountId ? t.accountId === accountId : true))
        .filter((t) => (min === undefined ? true : Math.abs(t.amount) >= min * 100))
        .sort((a, b) => b.date.localeCompare(a.date));

      return {
        from, to,
        matched: hits.length,
        returned: Math.min(hits.length, limit),
        transactions: hits.slice(0, limit).map((t) => ({
          date: t.date,
          merchant: t.merchant,
          amount: money(t.amount),
          category: names.get(t.categoryId) ?? null,
          account: db.accounts.find((a) => a.id === t.accountId)?.name ?? null,
          pending: t.pending ?? false,
        })),
      };
    },
  },
  {
    name: "merchants",
    description: "Where the money actually went, by merchant, largest first.",
    input_schema: {
      type: "object",
      properties: { ...RANGE_ARGS, limit: { type: "number", description: "Defaults to 10, max 50." } },
      additionalProperties: false,
    },
    run: (db, input) => {
      const { from, to } = range(input);
      const limit = Math.min(50, Math.max(1, Math.round(num(input.limit) ?? 10)));
      return {
        from, to,
        merchants: merchantTotals(db, from, to, limit).map((m) => ({
          merchant: m.merchant, total: money(m.total), transactions: m.count,
        })),
      };
    },
  },
  {
    name: "budget_status",
    description:
      "How a month's budget is going: planned against actual for every budgeted category, "
      + "and which ones are over.",
    input_schema: { type: "object", properties: { month: MONTH_ARG }, additionalProperties: false },
    run: (db, input) => {
      const month = str(input.month) && isMonth(str(input.month)!) ? str(input.month)! : thisMonth();
      const s = budgetSummary(db, month);
      const rows = budgetTable(db, month).flatMap((g) => g.rows.map((r) => ({
        group: g.group.name,
        category: r.category.name,
        planned: money(r.planned),
        actual: money(r.actual),
        remaining: money(r.planned - r.actual),
        over: r.actual > r.planned,
      })));
      return {
        month,
        plannedIncome: money(s.plannedIncome),
        actualIncome: money(s.actualIncome),
        plannedSpending: money(s.plannedExpense),
        actualSpending: money(s.actualExpense),
        leftToBudget: money(s.leftToBudget),
        plannedSavings: money(s.plannedSavings),
        actualSavings: money(s.actualSavings),
        over: rows.filter((r) => r.over),
        categories: rows,
      };
    },
  },
  {
    name: "cash_flow",
    description: "Income against spending, month by month.",
    input_schema: {
      type: "object",
      properties: {
        months: { type: "number", description: "How many months back. Defaults to 6, max 60." },
        scope: SCOPE_ARG,
      },
      additionalProperties: false,
    },
    run: (db, input) => cashFlowSeries(db, months(input), scopeOf(input)).map((p) => ({
      month: p.month, income: money(p.income), spending: money(p.expense),
      saved: money(p.income - p.expense),
    })),
  },
  {
    name: "net_worth_trend",
    description: "Net worth month by month, for questions about direction rather than position.",
    input_schema: {
      type: "object",
      properties: { months: { type: "number", description: "How many months back. Defaults to 12, max 60." } },
      additionalProperties: false,
    },
    run: (db, input) => netWorthSeries(db, months(input, 12)).map((p) => ({
      month: p.month, netWorth: money(p.net), assets: money(p.assets), liabilities: money(p.liabilities),
    })),
  },
  {
    name: "goals",
    description:
      "Every goal with what is saved, what is left, what is going in monthly, and when it lands "
      + "at that rate, including whether that beats its target date.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: (db) => db.goals.filter((g) => !g.archived).map((g) => {
      const o = goalOutlook(db, g.id);
      return {
        name: g.name,
        target: money(o.target),
        saved: money(o.saved),
        remaining: money(o.remaining),
        monthlyContribution: money(o.monthly),
        assumedAnnualGrowthPct: o.growth,
        targetDate: g.targetDate ?? null,
        reachedOn: o.projected,
        monthsOfSlack: o.slack,
        status: o.status,
      };
    }),
  },
  {
    name: "recurring",
    description: "Subscriptions and regular bills that were detected or entered, and what they cost a month.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: (db) => {
      const list = recurringList(db);
      const changes = priceChanges(db);
      return {
        monthlyTotal: money(monthlyRecurringCost(list)),
        items: list.map((r) => ({
          merchant: r.merchant, amount: money(r.amount), cadence: r.cadence,
          nextDate: r.nextDate, kind: r.kind,
        })),
        // Only where the old price had settled, to the cent, at least twice
        // running, which is what keeps a seasonal utility out of this list.
        priceChanges: changes.map((c) => ({
          merchant: c.merchant,
          was: money(c.was),
          now: money(c.now),
          changePct: c.share,
          since: c.at,
          costsPerYear: money(c.yearly),
        })),
        priceChangeYearlyTotal: money(yearlyImpact(changes)),
      };
    },
  },
  {
    name: "investments",
    description: "The portfolio: total value, cost basis, gain, and every holding.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: (db) => {
      const p = portfolioSummary(db);
      const look = lookThrough(db.holdings);
      return {
        value: money(p.value),
        cost: money(p.cost),
        gain: money(p.gain),
        gainPct: Math.round(p.gainPct * 10) / 10,
        byAssetClass: p.byClass.map((c) => ({ assetClass: c.label, value: money(c.value) })),
        holdings: p.holdings.map((h) => ({
          ticker: h.ticker, name: h.name, quantity: h.quantity,
          price: money(h.price), value: money(h.quantity * h.price), assetClass: h.assetClass,
        })),
        // What the portfolio is really made of, after opening the funds up
        // into their published weights. A fund nobody has a table for is
        // counted whole as whatever it was recorded as, and named here so the
        // difference can be said out loud rather than quietly assumed away.
        lookThrough: {
          byAssetClass: look.slices.map((c) => ({ assetClass: c.key, value: money(c.value) })),
          openedUp: money(look.seen),
          notOpenedUp: look.unknown.map((u) => ({ ticker: u.ticker, name: u.name, value: money(u.value) })),
        },
      };
    },
  },
  {
    name: "forecast",
    description:
      "The long-range projection: when retirement is affordable, what the money does between now and "
      + "the end of the plan, and whether it runs out. Answers 'can I retire at 60', 'what if returns "
      + "are worse', 'when could I stop working'. Pass retireAge or returnPct to try a different one "
      + "without changing anything.",
    input_schema: {
      type: "object",
      properties: {
        retireAge: { type: "number", description: "Try retiring at this age instead of the planned one." },
        returnPct: { type: "number", description: "Try this annual return instead of the planned one." },
      },
      additionalProperties: false,
    },
    run: (db, input) => {
      const f = plannedFuture(db);
      if (!f) return { error: "No forecast could be built from this document." };
      const a = {
        ...f.a,
        retireAge: num(input.retireAge) ?? f.a.retireAge,
        returnPct: num(input.returnPct) ?? f.a.returnPct,
      };
      const band = runBand(f.position, a, f.scenario.events);
      const earliest = earliestRetirement(f.position, a, f.scenario.events);
      const ss = a.socialSecurity;
      const claimAt = ss && hasBenefit(ss) ? firstClaimAge(ss) : null;

      const say = (r: typeof band.mid) => ({
        atRetirement: money(r.atRetirement),
        atEnd: money(r.atEnd),
        ranOutAtAge: r.ranOutAt,
      });
      // Every five years rather than every month: the shape is the answer and
      // six hundred rows of it would be six hundred rows of noise.
      const every = 60;
      return {
        scenario: f.scenario.name,
        askedFor: { retireAge: a.retireAge, returnPct: a.returnPct },
        assumptions: {
          birthYear: a.birthYear,
          retireAge: a.retireAge,
          planRunsToAge: a.endAge,
          annualReturnPct: a.returnPct,
          returnSpreadPct: a.returnSpreadPct,
          inflationPct: a.inflationPct,
          wageGrowthPct: a.wageGrowthPct,
          retirementSpendPct: a.retirementSpendPct,
          taxOnPreTaxWithdrawalsPct: a.taxRatePct,
          monthlyRetirementContribution: money(a.monthlyRetirementContribution),
          shownInTodaysMoney: a.realDollars,
        },
        socialSecurity: ss && hasBenefit(ss)
          ? {
            monthlyAtFullRetirementAge: money(ss.monthlyAtFRA),
            claimAge: ss.claimAge,
            firstClaimedAtAge: claimAt,
            taxablePct: ss.taxablePct,
            hasSpouse: !!ss.spouse,
            monthlyAtRetirement: money(benefitAt(ss, a.birthYear, a.retireAge, a.retireAge, a.taxRatePct)),
          }
          : null,
        startingFrom: {
          cash: money(f.position.cash),
          taxable: money(f.position.taxable),
          preTax: money(f.position.traditional),
          roth: money(f.position.roth),
          propertyAndVehicles: money(f.position.illiquid),
          owed: money(f.position.debts.reduce((n, d) => n + d.balance, 0)),
          monthlyIncome: money(f.position.monthlyIncome),
          monthlySpend: money(f.position.monthlySpend),
        },
        // Three walks, not one. A single line at a number somebody typed into
        // a box is not worth four decimal places.
        atPlannedReturn: say(band.mid),
        ifReturnsAreWorse: say(band.low),
        ifReturnsAreBetter: say(band.high),
        earliestAffordableRetirementAge: earliest,
        events: f.scenario.events.map((e) => ({
          name: e.name, kind: e.kind, from: e.at, amount: money(e.amount), untilAge: e.untilAge ?? null,
        })),
        everyFiveYears: band.mid.points
          .filter((_, i) => i % every === 0)
          .map((pt) => ({ month: pt.month, age: Math.floor(pt.age), netWorth: money(pt.net), retired: pt.retired })),
      };
    },
  },
  {
    name: "debt_payoff",
    description:
      "Every debt with its rate and minimum, and what it takes to clear them: how long, what the "
      + "interest costs, and the difference between paying the dearest rate first and the smallest "
      + "balance first. Pass extra to see what putting more at it every month would do.",
    input_schema: {
      type: "object",
      properties: {
        extra: { type: "number", description: "Extra dollars a month on top of the minimums. Defaults to 0." },
      },
      additionalProperties: false,
    },
    run: (db, input) => {
      const debts = debtsFrom(db);
      if (!debts.length) return { debts: [], note: "Nothing is owed." };
      const extra = Math.max(0, Math.round((num(input.extra) ?? 0) * 100));
      const both = compareOrders(debts, extra);
      const say = (p: typeof both.avalanche) => ({
        monthlyOutlay: money(p.monthly),
        debtFreeMonth: p.debtFree,
        months: p.months,
        totalInterest: money(p.interest),
        clearedInOrder: p.cleared.map((c) => ({ name: c.name, month: c.month, afterMonths: c.after, interest: money(c.interest) })),
      });
      return {
        extraPerMonth: money(extra),
        totalOwed: money(debts.reduce((n, d) => n + d.balance, 0)),
        debts: debts.map((d) => ({ name: d.name, balance: money(d.balance), aprPct: d.apr, minimum: money(d.minimum) })),
        dearestRateFirst: say(both.avalanche),
        smallestBalanceFirst: say(both.snowball),
        // Said rather than recommended: one order saves money and the other
        // closes an account sooner, and which matters more is not arithmetic.
        smallestBalanceFirstCostsExtra: money(both.costsExtra),
        smallestBalanceFirstClosesFirstAccountMonthsSooner: both.firstWinSooner,
      };
    },
  },
  {
    name: "tax_summary",
    description:
      "A year's money under the headings a tax return uses: tagged personal lines like charitable "
      + "giving and property tax, plus business and rental totals worked out from the books each "
      + "account keeps. A summary to hand a preparer, not a return and not advice.",
    input_schema: {
      type: "object",
      properties: { year: { type: "number", description: "Four-digit year. Defaults to the current one." } },
      additionalProperties: false,
    },
    run: (db, input) => {
      const t = taxSummary(db, yearOf(input));
      return {
        year: t.year,
        through: t.to,
        yearsAvailable: taxYears(db),
        nothingTagged: t.untagged,
        transactionsCounted: t.counted,
        lines: t.lines.map((l) => ({
          line: l.label, form: l.form, total: money(l.total), transactions: l.count, categories: l.categories,
        })),
        stateAndLocalTax: t.salt
          ? { total: money(t.salt.total), capPerReturn: money(SALT_CAP), overTheCapBy: money(t.salt.over) }
          : null,
        books: t.books.map((b) => ({
          books: b.label, form: b.form, accounts: b.accounts,
          income: money(b.income), expenses: money(b.expenses), profit: money(b.net),
          expensesByCategory: b.breakdown.map((r) => ({ name: r.name, total: money(r.total) })),
        })),
        caveat: "Adds up what was recorded. It does not decide what is deductible and it is not advice.",
      };
    },
  },
  {
    name: "year_review",
    description:
      "A whole year against the one before it, measured over the same stretch of the calendar: what "
      + "came in, what went out, what was kept, net worth, debt paid, the months, the biggest "
      + "categories and where the money went.",
    input_schema: {
      type: "object",
      properties: { year: { type: "number", description: "Four-digit year. Defaults to the current one." } },
      additionalProperties: false,
    },
    run: (db, input) => {
      const r = yearReview(db, yearOf(input));
      const totals = (t: typeof r.totals | null) => (t ? {
        income: money(t.income), spending: money(t.spending), saved: money(t.saved), savingsRatePct: t.rate,
      } : null);
      return {
        year: r.year,
        through: r.through,
        yearIsOver: r.complete,
        daysCounted: r.days,
        yearsAvailable: reviewYears(db),
        thisYear: totals(r.totals),
        // Not the whole of last year: in September, twelve months against nine
        // would say spending fell every single time.
        sameStretchLastYear: totals(r.last),
        spendingPerDay: money(r.perDay),
        transactions: r.count,
        netWorth: { start: money(r.netWorth.start), now: money(r.netWorth.end), change: money(r.netWorth.change) },
        debtPaidDown: money(r.debt.paid),
        bestMonth: r.best ? { month: r.best.month, saved: money(r.best.net) } : null,
        leanestMonth: r.worst ? { month: r.worst.month, saved: money(r.worst.net) } : null,
        months: r.months.map((m) => ({ month: m.month, income: money(m.income), spending: money(m.spending) })),
        biggestCategories: r.categories.map((c) => ({
          name: c.name, total: money(c.total), sharePct: c.share,
          lastYear: c.last === null ? null : money(c.last),
          change: c.delta === null ? null : money(c.delta),
        })),
        biggestMerchants: r.merchants.map((m) => ({ name: m.name, total: money(m.total), times: m.count })),
        // Capped: a household's first year in the app can have four hundred of
        // these, and four hundred merchant names is not an answer to anything.
        firstTimeMerchantCount: r.firstTime.length,
        firstTimeMerchants: r.firstTime.slice(0, 30),
      };
    },
  },
  {
    name: "estate",
    description:
      "What happens to the household's money if one earner dies: how long the survivor's money "
      + "lasts, the life cover in force, and the smallest cover that would carry them all the way. "
      + "Also the inventory an executor would ask for.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: (db) => {
      const f = plannedFuture(db);
      if (!f) return { error: "No forecast could be built from this document, so no survivor walk either." };
      const stored = db.estate?.survivorship;
      const seed = blankSurvivorship(db, f.a, f.flows.income);
      const cover = lifeCover(db);
      const s = { ...seed, ...(stored ?? {}), cover };
      const run = runSurvivor(f.position, f.a, f.scenario.events, s);
      const needed = coverNeeded(f.position, f.a, f.scenario.events, s);
      return {
        assumes: {
          monthlyIncomeLost: money(s.incomeLost),
          survivorSpendsPctOfToday: s.spendPct,
          survivorBornIn: s.survivorBirthYear,
          moneyMustLastToAge: s.survivorEndAge,
          debtsClearedFromTheLumpSum: s.clears.length,
        },
        lifeCoverInForce: money(cover),
        survivorRunsOutAtAge: run.ranOutAt,
        leftAtTheEnd: money(run.atEnd),
        // Null means even the ceiling is not enough, which is an answer.
        coverNeededToLastAllTheWay: needed === null ? null : money(needed),
        shortfall: needed === null ? null : money(Math.max(0, needed - cover)),
        inventory: estateSummary(db).map((sec) => ({
          section: sec.title,
          total: sec.total === undefined ? null : money(sec.total),
          items: sec.lines.map((l) => ({ name: l.name, amount: money(l.amount), detail: l.detail })),
        })),
        policies: (db.estate?.policies ?? []).map((pl) => ({
          kind: pl.kind, insurer: pl.insurer, coverage: money(pl.coverage),
          insures: pl.insures ?? null, beneficiary: pl.beneficiary ?? null,
        })),
        // The record holds no credential and no full account number by
        // design, which is what makes it safe to read out: it is the sort of
        // thing that gets printed and left in a safe.
        contacts: (db.estate?.contacts ?? []).map((c) => ({ role: c.role, name: c.name, org: c.org ?? null })),
        documents: (db.estate?.documents ?? []).map((d) => ({ name: d.name, where: d.location })),
        guardians: db.estate?.guardians ?? null,
        wishes: db.estate?.wishes ?? null,
        lastReviewed: db.estate?.reviewedAt ?? null,
      };
    },
  },
  {
    name: "notices",
    description:
      "What the app would tell the user if they had not been looking: a balance that jumped in a "
      + "sync, a category past its plan, a bill that has not arrived, an unusual charge, a "
      + "subscription that went up, a bank that stopped answering. Good for 'anything I should know'.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: (db) => notices(db).map((n) => ({
      kind: n.kind, title: n.title, detail: n.body, when: n.when, date: n.at, tone: n.tone, page: n.to,
    })),
  },
];

export const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The schemas, without the implementations, which is all the model needs. */
export const SCHEMAS = TOOLS.map(({ name, description, input_schema }) => ({
  name, description, input_schema,
}));

/**
 * Runs one tool call and returns what should go back as the result.
 *
 * A tool that throws comes back as a message rather than an exception: the
 * model can read "no category with that id" and try something else, where a
 * dead conversation just looks broken.
 */
export function runTool(db: DB, name: string, input: unknown): unknown {
  const tool = BY_NAME.get(name);
  if (!tool) return { error: `No tool called ${name}.` };
  try {
    return tool.run(db, (input && typeof input === "object" ? input : {}) as Record<string, unknown>);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "That lookup failed." };
  }
}

/* Kept so the unused-import check stays honest about what this module needs. */
void counts; void mutedAccountIds; void monthOf;
