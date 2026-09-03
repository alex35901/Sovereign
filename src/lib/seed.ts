import type { Account, DB, Goal, Holding, Rule, Transaction } from "../types";
import { defaultTaxonomy } from "./categories";
import { uid } from "./id";
import { addDays, addMonths, monthEnd, monthOf, parseISO, thisMonth, today } from "./date";

/** Deterministic PRNG so the demo file is identical on every machine. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MONTHS_BACK = 23;

type Spec = {
  cat: string;
  merchants: string[];
  /** dollars, low–high */
  range: [number, number];
  /** times per month */
  freq: number;
  account: "checking" | "sapphire" | "amex";
};

const VARIABLE: Spec[] = [
  { cat: "c_groceries", merchants: ["Whole Foods Market", "Trader Joe's", "Safeway", "Costco", "Sprouts Farmers Mkt"], range: [42, 214], freq: 5.2, account: "amex" },
  { cat: "c_restaurants_and_bars", merchants: ["Chipotle", "Sushi Yasu", "Blue Plate Diner", "Tacolicious", "Nopa", "Pizzeria Delfina", "Thai Basil", "The Coachman"], range: [18, 132], freq: 7.4, account: "sapphire" },
  { cat: "c_coffee_shops", merchants: ["Blue Bottle Coffee", "Starbucks", "Philz Coffee", "Ritual Coffee"], range: [5, 19], freq: 9.8, account: "sapphire" },
  { cat: "c_gas", merchants: ["Shell", "Chevron", "76 Station", "Costco Gas"], range: [38, 78], freq: 3.1, account: "sapphire" },
  { cat: "c_taxi_and_ride_shares", merchants: ["Uber", "Lyft"], range: [11, 48], freq: 2.4, account: "sapphire" },
  { cat: "c_parking_and_tolls", merchants: ["SFMTA Parking", "FasTrak", "ParkMobile"], range: [4, 32], freq: 2.0, account: "sapphire" },
  { cat: "c_shopping", merchants: ["Amazon", "Target", "Etsy", "REI Co-op", "Ace Hardware"], range: [16, 240], freq: 4.6, account: "amex" },
  { cat: "c_clothing", merchants: ["Uniqlo", "Madewell", "Nordstrom", "Allbirds"], range: [38, 190], freq: 0.9, account: "amex" },
  { cat: "c_electronics", merchants: ["Apple Store", "Best Buy", "B&H Photo"], range: [29, 420], freq: 0.4, account: "amex" },
  { cat: "c_furniture_and_housewares", merchants: ["IKEA", "West Elm", "Crate & Barrel"], range: [45, 380], freq: 0.4, account: "amex" },
  { cat: "c_entertainment_and_recreation", merchants: ["AMC Theatres", "Ticketmaster", "Alamo Drafthouse", "SF Rec & Park"], range: [16, 148], freq: 1.5, account: "sapphire" },
  { cat: "c_personal", merchants: ["Great Clips", "Sephora", "Barber & Co"], range: [22, 96], freq: 1.2, account: "sapphire" },
  { cat: "c_pets", merchants: ["Petco", "Bay Area Vet Clinic", "Chewy"], range: [24, 210], freq: 1.1, account: "amex" },
  { cat: "c_medical", merchants: ["Sutter Health", "Walgreens Pharmacy", "One Medical"], range: [15, 265], freq: 1.0, account: "sapphire" },
  { cat: "c_home_improvement", merchants: ["Home Depot", "Lowe's", "Cole Hardware"], range: [24, 340], freq: 1.0, account: "amex" },
  { cat: "c_gifts", merchants: ["Bookshop.org", "Etsy Gift", "Papyrus"], range: [18, 120], freq: 0.7, account: "amex" },
  { cat: "c_cash_and_atm", merchants: ["ATM Withdrawal"], range: [40, 200], freq: 0.6, account: "checking" },
  { cat: "c_public_transit", merchants: ["Clipper Card", "BART"], range: [10, 40], freq: 1.2, account: "sapphire" },
];

/** [day of month, merchant, category, dollars, account] — fixed monthly bills. */
const FIXED: [number, string, string, number, Spec["account"]][] = [
  [1, "Wells Fargo Home Mortgage", "c_mortgage", 2846.12, "checking"],
  [3, "State Farm Insurance", "c_insurance", 214.4, "checking"],
  [5, "Comcast Xfinity", "c_internet_and_cable", 89.99, "sapphire"],
  [7, "PG&E", "c_gas_and_electric", 168.3, "checking"],
  [8, "Verizon Wireless", "c_phone", 118.42, "sapphire"],
  [9, "Netflix", "c_entertainment_and_recreation", 22.99, "sapphire"],
  [11, "Spotify", "c_entertainment_and_recreation", 11.99, "sapphire"],
  [12, "Equinox", "c_fitness", 210.0, "sapphire"],
  [14, "Toyota Financial Services", "c_auto_payment", 412.88, "checking"],
  [15, "Bright Horizons Childcare", "c_child_care", 1480.0, "checking"],
  [18, "iCloud+", "c_miscellaneous", 9.99, "sapphire"],
  [20, "Recology", "c_garbage", 46.2, "checking"],
  [24, "SF Water Power Sewer", "c_water", 92.15, "checking"],
  [26, "Little Kickers Soccer", "c_child_activities", 95.0, "sapphire"],
  [28, "Sierra Club", "c_charity", 50.0, "amex"],
];

const cents = (d: number) => Math.round(d * 100);

export function buildDemoDB(): DB {
  const rand = rng(20260828);
  const { groups, categories } = defaultTaxonomy();
  const start = `${addMonths(thisMonth(), -MONTHS_BACK)}-01`;
  const end = today();

  const acct = (
    id: string, name: string, institution: string, type: Account["type"],
    mask: string, order: number,
  ): Account => ({
    id, name, institution, type, mask, balance: 0,
    includeInNetWorth: true, hidden: false, history: [], syncSource: "manual", order,
  });

  const accounts: Account[] = [
    acct("a_checking", "Everyday Checking", "Chase", "checking", "4412", 0),
    // Money set aside, some of it already spoken for. Marked as an account
    // goals draw on so a fresh demo has something in "available for goals" to
    // decide about, rather than an empty box.
    { ...acct("a_savings", "High Yield Savings", "Ally Bank", "savings", "8821", 1), goalAccount: true },
    acct("a_sapphire", "Sapphire Reserve", "Chase", "credit", "9013", 2),
    acct("a_amex", "Blue Cash Preferred", "American Express", "credit", "1007", 3),
    acct("a_brokerage", "Individual Brokerage", "Fidelity", "investment", "5520", 4),
    acct("a_401k", "401(k)", "Vanguard", "retirement", "7734", 5),
    acct("a_roth", "Roth IRA", "Vanguard", "retirement", "2298", 6),
    acct("a_home", "Primary Residence", "Manual", "real_estate", "", 7),
    acct("a_mortgage", "Home Mortgage", "Wells Fargo", "mortgage", "3390", 8),
    acct("a_auto", "Auto Loan", "Toyota Financial", "loan", "6612", 9),
  ];
  const accountIdFor = { checking: "a_checking", sapphire: "a_sapphire", amex: "a_amex" };

  const txns: Transaction[] = [];
  let n = 0;
  const push = (t: Omit<Transaction, "id" | "tags" | "pending" | "reviewed" | "hideFromReports" | "createdAt">) => {
    const daysOld = (parseISO(end).getTime() - parseISO(t.date).getTime()) / 86400000;
    txns.push({
      ...t,
      id: `t${(n++).toString(36)}`,
      tags: [],
      pending: daysOld < 2 && rand() < 0.5,
      reviewed: daysOld > 21,
      hideFromReports: false,
      createdAt: new Date().toISOString(),
    });
  };
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);

  // ── paychecks: every other Friday, with a raise partway through ──────────
  let payDate = start;
  while (parseISO(payDate).getDay() !== 5) payDate = addDays(payDate, 1);
  let payNo = 0;
  for (let d = payDate; d <= end; d = addDays(d, 14)) {
    const raise = payNo > 17 ? 1.062 : 1;
    push({
      accountId: "a_checking", date: d, merchant: "Aperture Labs Payroll",
      statement: "DIRECT DEP APERTURE LABS PPD ID:1234567890",
      amount: cents(4995.4 * raise + between(-60, 60)), categoryId: "c_paychecks",
    });
    payNo++;
  }

  // ── the fixed monthly set ────────────────────────────────────────────────
  for (let m = 0; m <= MONTHS_BACK; m++) {
    const month = addMonths(monthOf(start), m);
    for (const [day, merchant, cat, amount, account] of FIXED) {
      const date = `${month}-${String(day).padStart(2, "0")}`;
      if (date > end) continue;
      // utilities swing with the season; everything else is flat
      const seasonal = cat === "c_gas_and_electric" ? between(0.72, 1.46) : 1;
      push({
        accountId: accountIdFor[account], date, merchant,
        amount: -cents(amount * seasonal), categoryId: cat,
      });
    }

    // savings transfer + credit-card payments, as matched pairs
    const sweepDate = `${month}-16`;
    if (sweepDate <= end) {
      const sweep = cents(1200 + Math.round(between(0, 600) / 50) * 50);
      push({ accountId: "a_checking", date: sweepDate, merchant: "Transfer to Ally Savings", amount: -sweep, categoryId: "c_savings_transfer" });
      push({ accountId: "a_savings", date: sweepDate, merchant: "Transfer from Chase Checking", amount: sweep, categoryId: "c_savings_transfer" });
    }
    const interestDate = monthEnd(month);
    if (interestDate <= end) {
      push({ accountId: "a_savings", date: interestDate, merchant: "Ally Bank Interest", amount: cents(between(52, 141)), categoryId: "c_interest" });
    }
  }

  // ── variable spending ────────────────────────────────────────────────────
  for (let m = 0; m <= MONTHS_BACK; m++) {
    const month = addMonths(monthOf(start), m);
    const dim = parseISO(monthEnd(month)).getDate();
    // December runs hot, January runs cold
    const mood = month.endsWith("-12") ? 1.32 : month.endsWith("-01") ? 0.86 : between(0.9, 1.12);
    for (const spec of VARIABLE) {
      const count = Math.round(spec.freq * mood + between(-0.6, 0.6));
      for (let i = 0; i < Math.max(0, count); i++) {
        const date = `${month}-${String(1 + Math.floor(rand() * dim)).padStart(2, "0")}`;
        if (date > end) continue;
        const merchant = pick(spec.merchants);
        push({
          accountId: accountIdFor[spec.account], date, merchant,
          statement: merchant.toUpperCase().replace(/[^A-Z0-9 ]/g, "") + " " + String(Math.floor(rand() * 9000) + 1000),
          amount: -cents(between(spec.range[0], spec.range[1]) * (spec.cat === "c_groceries" ? mood : 1)),
          categoryId: spec.cat,
        });
      }
    }
    // one trip every few months
    if (rand() < 0.28) {
      const date = `${month}-${String(4 + Math.floor(rand() * 20)).padStart(2, "0")}`;
      if (date <= end) {
        push({ accountId: "a_sapphire", date, merchant: pick(["Alaska Airlines", "United Airlines", "Airbnb", "Marriott Bonvoy"]), amount: -cents(between(320, 1850)), categoryId: "c_travel_and_vacation" });
      }
    }
    // annual-ish odds and ends
    if (month.endsWith("-04")) {
      const d = `${month}-14`;
      if (d <= end) push({ accountId: "a_checking", date: d, merchant: "IRS USATAXPYMT", amount: -cents(between(1400, 3200)), categoryId: "c_taxes" });
    }
    if (month.endsWith("-03")) {
      const d = `${month}-22`;
      if (d <= end) push({ accountId: "a_amex", date: d, merchant: "Amazon Prime Annual", amount: -cents(139), categoryId: "c_miscellaneous" });
    }
  }

  // ── credit-card payments: pay off last month's balance on the 20th ───────
  for (const card of ["a_sapphire", "a_amex"] as const) {
    for (let m = 1; m <= MONTHS_BACK; m++) {
      const month = addMonths(monthOf(start), m);
      const prev = addMonths(month, -1);
      const owed = -txns
        .filter((t) => t.accountId === card && monthOf(t.date) === prev && t.amount < 0)
        .reduce((a, t) => a + t.amount, 0);
      if (owed <= 0) continue;
      const date = `${month}-20`;
      if (date > end) continue;
      const label = card === "a_sapphire" ? "Chase Card Payment" : "Amex Autopay";
      push({ accountId: "a_checking", date, merchant: label, amount: -owed, categoryId: "c_credit_card_payment" });
      push({ accountId: card, date, merchant: "Payment Thank You", amount: owed, categoryId: "c_credit_card_payment" });
    }
  }

  txns.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // ── balances: cash accounts are derived from their own transactions ──────
  const OPENING: Record<string, number> = {
    a_checking: cents(6200), a_savings: cents(18400), a_sapphire: 0, a_amex: 0,
  };
  for (const id of Object.keys(OPENING)) {
    const rows = txns.filter((t) => t.accountId === id).slice().reverse();
    let bal = OPENING[id];
    const hist: { date: string; balance: number }[] = [];
    let cursor = monthEnd(monthOf(start));
    for (const t of rows) {
      while (t.date > cursor) {
        hist.push({ date: cursor, balance: Math.round(bal) });
        cursor = monthEnd(addMonths(monthOf(cursor), 1));
      }
      bal += t.amount;
    }
    hist.push({ date: end, balance: Math.round(bal) });
    const a = accounts.find((x) => x.id === id)!;
    a.history = hist;
    a.balance = Math.round(bal);
  }

  // ── market-driven and amortizing accounts ────────────────────────────────
  const curve = (
    id: string, startValue: number, monthlyAdd: number, annualRate: number, vol: number,
  ) => {
    const a = accounts.find((x) => x.id === id)!;
    let v = startValue;
    const hist: { date: string; balance: number }[] = [];
    for (let m = 0; m <= MONTHS_BACK; m++) {
      const month = addMonths(monthOf(start), m);
      v = v * (1 + annualRate / 12 + (rand() - 0.5) * vol) + monthlyAdd;
      const d = m === MONTHS_BACK ? end : monthEnd(month);
      hist.push({ date: d, balance: Math.round(v) });
    }
    a.history = hist;
    a.balance = Math.round(v);
  };
  curve("a_brokerage", cents(41200), cents(600), 0.091, 0.036);
  curve("a_401k", cents(198400), cents(1750), 0.083, 0.031);
  curve("a_roth", cents(64800), cents(541), 0.088, 0.033);
  curve("a_home", cents(1085000), 0, 0.034, 0.002);

  const amortize = (id: string, startBal: number, monthlyPrincipal: number) => {
    const a = accounts.find((x) => x.id === id)!;
    let v = startBal;
    const hist: { date: string; balance: number }[] = [];
    for (let m = 0; m <= MONTHS_BACK; m++) {
      v = Math.min(0, v + monthlyPrincipal);
      hist.push({ date: m === MONTHS_BACK ? end : monthEnd(addMonths(monthOf(start), m)), balance: Math.round(v) });
    }
    a.history = hist;
    a.balance = Math.round(v);
  };
  amortize("a_mortgage", -cents(742300), cents(1180));
  amortize("a_auto", -cents(28400), cents(365));

  const holdings: Holding[] = [
    { id: uid("h"), accountId: "a_brokerage", ticker: "VTI", name: "Vanguard Total Stock Market ETF", quantity: 118.42, costBasis: cents(214.1), price: cents(312.66), assetClass: "us_equity" },
    { id: uid("h"), accountId: "a_brokerage", ticker: "VXUS", name: "Vanguard Total Intl Stock ETF", quantity: 96.3, costBasis: cents(56.2), price: cents(74.18), assetClass: "intl_equity" },
    { id: uid("h"), accountId: "a_brokerage", ticker: "AAPL", name: "Apple Inc.", quantity: 42, costBasis: cents(148.9), price: cents(241.55), assetClass: "us_equity" },
    { id: uid("h"), accountId: "a_brokerage", ticker: "SPAXX", name: "Fidelity Government Money Market", quantity: 4180.11, costBasis: cents(1), price: cents(1), assetClass: "cash" },
    { id: uid("h"), accountId: "a_401k", ticker: "VFIAX", name: "Vanguard 500 Index Admiral", quantity: 402.8, costBasis: cents(392.4), price: cents(561.22), assetClass: "us_equity" },
    { id: uid("h"), accountId: "a_401k", ticker: "VTIAX", name: "Vanguard Total Intl Index Admiral", quantity: 611.4, costBasis: cents(29.8), price: cents(38.94), assetClass: "intl_equity" },
    { id: uid("h"), accountId: "a_401k", ticker: "VBTLX", name: "Vanguard Total Bond Market Admiral", quantity: 780.2, costBasis: cents(10.4), price: cents(9.81), assetClass: "bond" },
    { id: uid("h"), accountId: "a_roth", ticker: "VTWAX", name: "Vanguard Total World Stock Admiral", quantity: 1402.6, costBasis: cents(34.1), price: cents(48.02), assetClass: "us_equity" },
  ];

  // make each investment account's balance agree with the positions inside it,
  // scaling its history so the growth curve still lands on the right number
  for (const id of ["a_brokerage", "a_401k", "a_roth"]) {
    const a = accounts.find((x) => x.id === id)!;
    const target = holdings
      .filter((h) => h.accountId === id)
      .reduce((s, h) => s + Math.round(h.quantity * h.price), 0);
    if (!target || !a.balance) continue;
    const factor = target / a.balance;
    a.history = a.history.map((h) => ({ ...h, balance: Math.round(h.balance * factor) }));
    a.balance = target;
  }

  // Written in the shape the app uses today rather than the one it used to, so
  // a fresh demo has nothing to migrate. Clamped to what the savings account
  // actually holds, because that total comes out of the generated
  // transactions and is not a number anyone here can promise.
  const savingsBalance = accounts.find((a) => a.id === "a_savings")?.balance ?? 0;
  const efundHeld = Math.max(0, Math.min(cents(24000), savingsBalance));

  const goals: Goal[] = [
    { id: "gl_efund", name: "Emergency Fund", emoji: "\u{1F6DF}", targetAmount: cents(30000), accountIds: [], allocations: { a_savings: efundHeld }, startingAmount: 0, monthlyContribution: cents(600), priority: 0, archived: false },
    { id: "gl_kitchen", name: "Kitchen Remodel", emoji: "\u{1F373}", targetAmount: cents(28000), targetDate: `${addMonths(thisMonth(), 14)}-01`, accountIds: [], allocations: {}, startingAmount: cents(6400), monthlyContribution: cents(900), priority: 1, archived: false },
    { id: "gl_japan", name: "Japan 2027", emoji: "\u{1F1EF}\u{1F1F5}", targetAmount: cents(9500), targetDate: `${addMonths(thisMonth(), 10)}-01`, accountIds: [], allocations: {}, startingAmount: cents(2100), monthlyContribution: cents(450), priority: 2, archived: false },
  ];

  const rules: Rule[] = [
    { id: uid("r"), name: "Blue Bottle → Coffee Shops", enabled: true, order: 0, criteria: { merchantContains: "blue bottle" }, actions: { categoryId: "c_coffee_shops" } },
    { id: uid("r"), name: "Payroll is income", enabled: true, order: 1, criteria: { merchantContains: "payroll", direction: "in" }, actions: { categoryId: "c_paychecks", markReviewed: true } },
  ];

  const db: DB = {
    version: 1,
    accounts, groups, categories, transactions: txns,
    tags: [
      { id: "tg_reimburse", name: "Reimbursable", color: "--c5" },
      { id: "tg_tax", name: "Tax deductible", color: "--c3" },
    ],
    budgets: {},
    goals, recurring: [], rules, holdings,
    settings: {
      theme: "dark", currency: "USD", privacyMode: false,
      startPage: "/dashboard", householdName: "My household",
    },
  };

  // seed the last 6 months of budgets from trailing averages
  for (let m = -5; m <= 1; m++) {
    const month = addMonths(thisMonth(), m);
    db.budgets[month] = plannedFromHistory(db, month);
  }
  return db;
}

/** Average of the three months before `month`, rounded to $5 — the "auto-fill" default. */
export function plannedFromHistory(db: DB, month: string): Record<string, number> {
  const out: Record<string, number> = {};
  const prior = [addMonths(month, -1), addMonths(month, -2), addMonths(month, -3)];
  for (const cat of db.categories) {
    if (cat.excludeFromBudget) continue;
    let total = 0;
    let seen = 0;
    for (const p of prior) {
      const inMonth = db.transactions.filter((t) => monthOf(t.date) === p && t.categoryId === cat.id && !t.hideFromReports);
      if (!inMonth.length) continue;
      seen++;
      total += Math.abs(inMonth.reduce((a, t) => a + t.amount, 0));
    }
    if (!seen) continue;
    const avg = total / seen;
    if (avg < 500) continue;
    out[cat.id] = Math.round(avg / 500) * 500;
  }
  return out;
}

/** A brand-new install: taxonomy and settings, nothing else. */
export function emptyDB(): DB {
  const { groups, categories } = defaultTaxonomy();
  return {
    version: 1,
    accounts: [], groups, categories, transactions: [], tags: [],
    budgets: {}, goals: [], recurring: [], rules: [], holdings: [],
    settings: { theme: "dark", currency: "USD", privacyMode: false, startPage: "/dashboard", householdName: "My household" },
  };
}

