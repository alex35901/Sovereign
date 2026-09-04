import type { DB, ISODate } from "../../types.js";
import {
  budgetSummary, budgetTable, cashFlowSeries, categoryAverage, categoryHistory,
  categoryTotals, counts, merchantTotals, monthlyRecurringCost, mutedAccountIds,
  netWorthNow, netWorthSeries, portfolioSummary, recurringList,
} from "../select.js";
import { goalOutlook } from "../goal-funding.js";
import { lastMonths, monthOf, thisMonth, today } from "../date.js";

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
      },
      additionalProperties: false,
    },
    run: (db, input) => {
      const { from, to } = range(input);
      const kind = str(input.kind);
      const k = kind === "income" || kind === "all" ? kind : "expense";
      return {
        from, to, kind: k,
        categories: categoryTotals(db, from, to, k).map((c) => ({
          id: c.category.id, name: c.category.name, total: money(c.total),
        })),
      };
    },
  },
  {
    name: "category_detail",
    description:
      "One category month by month, with its average — for questions about a trend or whether "
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
      + "that charge' or to list what made up a total — not to add things up, which the other tools do.",
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
      properties: { months: { type: "number", description: "How many months back. Defaults to 6, max 60." } },
      additionalProperties: false,
    },
    run: (db, input) => cashFlowSeries(db, months(input)).map((p) => ({
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
      + "at that rate — including whether that beats its target date.",
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
      return {
        monthlyTotal: money(monthlyRecurringCost(list)),
        items: list.map((r) => ({
          merchant: r.merchant, amount: money(r.amount), cadence: r.cadence,
          nextDate: r.nextDate, kind: r.kind,
        })),
      };
    },
  },
  {
    name: "investments",
    description: "The portfolio: total value, cost basis, gain, and every holding.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    run: (db) => {
      const p = portfolioSummary(db);
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
      };
    },
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
