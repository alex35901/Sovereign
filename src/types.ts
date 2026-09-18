import type { SyncCadence } from "./lib/sync/schedule.js";
import type { Usage } from "./lib/usage.js";
/** All money is integer cents. Outflows are negative, inflows positive. */
export type ID = string;
export type ISODate = string; // YYYY-MM-DD
export type MonthKey = string; // YYYY-MM

/**
 * Which set of books a thing belongs in.
 *
 * Absent means personal, deliberately: every document that existed before this
 * did is entirely personal, and a field that has to be filled in before
 * anything works is a field most people will never fill in.
 *
 * A rental is its own bucket rather than a kind of business because the two
 * answer different questions at tax time and because most landlords do not
 * think of themselves as running a business.
 */
export type Bucket = "personal" | "business" | "rental";

export type AccountType =
  | "checking" | "savings" | "credit" | "investment" | "retirement"
  | "loan" | "mortgage" | "real_estate" | "vehicle" | "crypto" | "other_asset" | "other_liability";

export interface Account {
  id: ID;
  name: string;
  institution: string;
  type: AccountType;
  mask?: string;
  /** Signed: liabilities are stored negative, matching net-worth math. */
  balance: number;
  includeInNetWorth: boolean;
  hidden: boolean;
  /** Keep this account's transactions out of cash flow, budgets and reports. */
  hideTransactions?: boolean;
  /**
   * This account's balance is money set aside for goals.
   *
   * Only these accounts are pooled and allocated. Everything else — the
   * current account the bills come out of, the mortgage — is deliberately not
   * offered, because "available for goals" means nothing if it includes the
   * rent.
   */
  goalAccount?: boolean;
  /**
   * Whatever is left over here belongs to this goal, without being allocated.
   *
   * For an account with exactly one purpose — a 401(k) that is retirement and
   * nothing else — so money arriving in it counts immediately rather than
   * waiting to be assigned. Computed rather than swept on a schedule, so it is
   * right the moment a balance changes.
   */
  autoGoalId?: ID;
  /**
   * Left out of the payoff plan, though still owed.
   *
   * For a card that is cleared every month - put everything on it for the
   * points, pay it off, carry nothing. The balance is real and net worth
   * still counts it; what it is not is debt to pay down, and leaving it in
   * puts a 22% card at the top of a plan it does not belong in.
   */
  excludeFromPayoff?: boolean;
  /** Closed on this date: balance zeroed, history kept, sync stops touching it. */
  closedAt?: ISODate;
  /** Sparse snapshots, ascending by date; forward-filled when charting. */
  history: { date: ISODate; balance: number }[];
  /** The institution's logo as a data URI, when the provider supplies one. */
  logo?: string;
  /** The institution's website, used to look a logo up when it doesn't. */
  domain?: string;
  /**
   * Which pot the forecast draws this account from.
   *
   * Only the forecast reads it, and only investable accounts have one. Unset
   * means "work it out from the type and the name", which gets a 401(k) and a
   * Roth IRA right without anybody being asked.
   */
  taxTreatment?: "taxable" | "traditional" | "roth";
  /**
   * Which books this account keeps. Absent is personal.
   *
   * Every transaction on it inherits this unless it says otherwise, which is
   * what makes a business card work without touching a single row.
   */
  bucket?: Bucket;
  /**
   * What the estate summary needs to say about this account, and nothing else.
   *
   * Two facts the rest of the app has no use for and an executor cannot do
   * without: a joint account passes straight to the other holder and never
   * touches the will, and a named beneficiary on a retirement account beats
   * whatever the will says. Getting either wrong is how money ends up in
   * probate for a year.
   */
  estate?: {
    ownership?: "sole" | "joint" | "trust";
    beneficiary?: string;
    note?: string;
  };
  syncSource?: "manual" | "csv" | "simplefin" | "plaid";
  syncId?: string;
  lastSyncedAt?: string;
  /** Street address, for property accounts that can be valued automatically. */
  address?: string;
  /** The most recent automated valuation, kept for provenance. */
  valuation?: { source: "rentcast"; low?: number; high?: number; at: string };
  /**
   * When a valuation was last attempted, whether or not it worked. A failure
   * has to age like a success, or an address RentCast cannot find would be
   * retried on every tick and spend the month's allowance getting nowhere.
   */
  valuationTriedAt?: string;
  /** Depreciation inputs for a vehicle account. */
  vehicle?: VehicleProfile;
  order: number;
}

export type GroupKind = "income" | "expense" | "transfer";

/**
 * Where a category's money lands on a tax return.
 *
 * Deliberately a short list of the lines a household actually hunts for in
 * January, not a chart of accounts. Anything to do with a business or a
 * rental is worked out from the books a transaction belongs to instead, so
 * the same dollar never gets tagged twice.
 */
export type TaxLine =
  | "charitable"
  | "mortgage_interest"
  | "property_tax"
  | "state_local_tax"
  | "medical"
  | "childcare"
  | "student_loan_interest"
  | "hsa"
  | "retirement"
  | "education"
  | "estimated_tax"
  | "interest_income"
  | "dividend_income";

export interface CategoryGroup {
  id: ID;
  name: string;
  kind: GroupKind;
  order: number;
  /**
   * The colour every category in this group wears. Absent means it has never
   * been chosen, and one is inferred from the categories already inside.
   */
  color?: string;
}

export interface Category {
  id: ID;
  groupId: ID;
  name: string;
  icon: string;
  /**
   * Derived from the group, not set here — withGroupColors keeps it in step on
   * every write. Kept on the category because everything that draws one reads
   * it from here.
   */
  color: string;
  excludeFromBudget: boolean;
  rollover: boolean;
  order: number;
  archived?: boolean;
  /** Which line of a tax return this category's money belongs on, if any. */
  taxLine?: TaxLine;
}

export interface Split { id: ID; categoryId: ID; amount: number; notes?: string }

export interface Transaction {
  id: ID;
  accountId: ID;
  date: ISODate;
  merchant: string;
  /** Raw description as it arrived from the bank/CSV. */
  statement?: string;
  amount: number;
  categoryId: ID;
  notes?: string;
  tags: ID[];
  pending: boolean;
  reviewed: boolean;
  hideFromReports: boolean;
  /**
   * Overrides the account's books, for this row only.
   *
   * The case this exists for is the one that makes the whole feature usable: a
   * client lunch on a personal card. Without it a household with a business
   * has to open a second card before any of this means anything.
   */
  bucket?: Bucket;
  recurringId?: ID;
  splits?: Split[];
  /** Stable hash of source fields, used to de-duplicate imports. */
  importKey?: string;
  createdAt: string;
  /** How it arrived and what has been changed since, oldest first. */
  activity?: TxnEvent[];
}

/** One line of a transaction's history. */
export interface TxnEvent {
  at: string;
  kind: "added" | "changed";
  /** For "added": where it came from — Plaid, SimpleFIN, a CSV, or by hand. */
  source?: string;
  /** For "changed": what moved, and from what to what, already in words. */
  field?: string;
  from?: string;
  to?: string;
}

export interface Tag { id: ID; name: string; color: string }

/** budgets[month][categoryId] = planned amount, always positive cents. */
export type Budgets = Record<MonthKey, Record<ID, number>>;

export interface Goal {
  id: ID;
  name: string;
  emoji: string;
  targetAmount: number;
  targetDate?: ISODate;
  /**
   * Superseded by `allocations`, kept so old documents still open.
   *
   * A goal used to take the whole balance of every account listed here, which
   * meant one account could not be shared: two goals pointing at the same
   * savings account each counted all of it, and the two of them together
   * claimed twice the money that existed.
   */
  accountIds: ID[];
  /**
   * How much of each goal account this goal has claimed, in cents.
   *
   * The sum across every goal can never exceed an account's balance — that is
   * what makes "available for goals" a real figure rather than an optimistic
   * one.
   */
  allocations?: Record<ID, number>;
  /** Manual starting contribution when no account is linked. */
  startingAmount: number;
  monthlyContribution: number;
  /**
   * Assumed annual return, as a percentage. Absent means none assumed.
   *
   * Contributions alone answer "when will I have put this much aside", which
   * is the right question for a kitchen and the wrong one for retirement:
   * thirty years of a balance that never earns anything is not conservative,
   * it is wrong by a factor of three. It is per goal and never filled in for
   * anyone, because the number is a judgement about where the money is, and
   * the app has no business making it silently.
   */
  growthRate?: number;
  priority: number;
  archived: boolean;
}

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "semiannual" | "yearly";

export interface Recurring {
  id: ID;
  merchant: string;
  categoryId: ID;
  accountId?: ID;
  amount: number;
  cadence: Cadence;
  nextDate: ISODate;
  kind: "bill" | "income" | "subscription";
  /** true when detected from history rather than entered by hand */
  detected: boolean;
  /**
   * The day the pattern completed — the third charge, which is what made this
   * detectable at all. Not the day it was noticed: detection is recomputed
   * from the transactions every time, so "when it was noticed" would be now,
   * every time, and nothing could ever be new.
   */
  detectedAt?: ISODate;
  dismissed?: boolean;
}

export interface RuleCriteria {
  merchantContains?: string;
  /**
   * How `merchantContains` is compared. Absent means "contains", which is what
   * every rule written before this existed meant, so old rules keep working.
   * Monarch's rules distinguish the two and its exports say which.
   */
  merchantMatch?: "contains" | "exact" | "starts" | "ends";
  accountId?: ID;
  amountMin?: number;
  amountMax?: number;
  direction?: "in" | "out";
}
export interface RuleActions {
  categoryId?: ID;
  renameMerchant?: string;
  addTags?: ID[];
  hideFromReports?: boolean;
  markReviewed?: boolean;
}
export interface Rule { id: ID; name: string; enabled: boolean; order: number; criteria: RuleCriteria; actions: RuleActions }

export type AssetClass = "us_equity" | "intl_equity" | "bond" | "cash" | "crypto" | "real_estate" | "other";

export interface Holding {
  id: ID;
  accountId: ID;
  ticker: string;
  name: string;
  quantity: number;
  costBasis: number; // per share, cents
  price: number; // per share, cents
  assetClass: AssetClass;
  /**
   * What kind of instrument it is, as the provider named it: "etf", "mutual
   * fund", "equity", "fixed income", "cash".
   *
   * A different question from assetClass, which is what the money is *in*. An
   * S&P 500 index fund and an S&P 500 ETF hold the same thing and are not the
   * same product. Only a provider that says so fills this in; a holding typed
   * in by hand leaves it empty rather than guessing from the name.
   */
  securityType?: string;
}

export interface Settings {
  theme: "dark" | "light";
  currency: string;
  /**
   * Notifications the household has read, by id, with when. Ids encode what
   * was true — a budget category and how far past it — so escalating past the
   * next threshold makes a new one rather than reviving the old.
   */
  seenNotices?: Record<string, string>;
  startPage: string;
  householdName: string;
  /** SimpleFIN access URL, stored locally. Empty until the user connects. */
  simplefinAccessUrl?: string;
  /** RentCast API key for property valuations, stored locally. */
  rentcastApiKey?: string;
  /** Tiingo API token for holding prices, stored locally. */
  tiingoApiKey?: string;
  /** Whether holding prices refresh on their own, alongside the account sync. */
  priceAutoRefresh?: boolean;
  /** When prices were last asked for, successfully or not. */
  lastPricesAt?: string;
  /** How much of each provider's free tier has been spent. See lib/usage.ts. */
  usage?: Usage;
  /**
   * What the model has already said an unfamiliar statement line was, kept so
   * the same merchant is never paid for twice. Keyed by the normalised line,
   * bounded, and dropped oldest first — see lib/hopper/explain.ts.
   */
  explanations?: Record<string, { text: string; at: string }>;
  /**
   * Whether property values refresh on their own. The cadence is not stored:
   * it is worked out from how many properties there are against RentCast's
   * monthly allowance, so adding one slows them all rather than overrunning.
   */
  propertyAutoRefresh?: boolean;
  /** Connected Plaid items. Credentials for Plaid itself live server-side. */
  plaidItems?: PlaidItemRef[];
  lastSyncAt?: string;
  /** How often to pull from SimpleFIN while the app is open. */
  syncCadence?: SyncCadence;
  /**
   * Look institution logos up from their domain when the provider gives no
   * logo of its own. Off means initials, and nothing leaves this app for it.
   */
  institutionLogos?: boolean;
  /**
   * Show a merchant's logo in place of its initial. Only merchants on the
   * built-in brand list are ever looked up — see lib/merchant-domain.ts.
   */
  merchantLogos?: boolean;
  /**
   * Accounts deleted on purpose. Without this a provider hands the same account
   * back on the next pull and it reappears, which reads as the delete failing.
   */
  deletedAccountKeys?: string[];
}

export interface VehicleProfile {
  purchasePrice: number;
  purchaseDate: ISODate;
  class: "car" | "suv" | "truck" | "hybrid" | "ev" | "luxury";
  annualMiles?: number;
  autoUpdate: boolean;
}

export interface PlaidItemRef {
  accessToken: string;
  itemId: string;
  institution: string;
  /** The institution's logo, fetched when the item was connected or backfilled. */
  logo?: string;
  domain?: string;
  /**
   * When the institution was last asked about. Items connected before the app
   * kept logos have neither mark, and a sync backfills them; this stops a bank
   * Plaid holds no logo for from being asked again on every single sync.
   */
  institutionCheckedAt?: string;
  kind: "bank" | "investment";
  addedAt: string;
  lastSyncAt?: string;
}

import type { ForecastPlan } from "./lib/forecast.js";
import type { Survivorship } from "./lib/estate.js";

/**
 * A policy that pays out, and who to.
 *
 * The policy number is here because it is what a claim is made with and the
 * summary is useless without it. A password is not, and never will be: the
 * whole point of this record is that it can be printed and left somewhere, and
 * a printed page holding credentials is the most dangerous thing anyone owns.
 */
export interface Policy {
  id: ID;
  kind: "life" | "disability" | "other";
  insurer: string;
  policyNumber?: string;
  /** What it pays out. Life cover feeds the survivor forecast. */
  coverage: number;
  /** Whose life it is on, when a household has more than one. */
  insures?: string;
  beneficiary?: string;
  note?: string;
}

/** Somebody the family will have to ring: attorney, executor, guardian. */
export interface EstateContact {
  id: ID;
  role: string;
  name: string;
  org?: string;
  phone?: string;
  email?: string;
  note?: string;
}

/** A piece of paper, and where it physically is. */
export interface EstateDocument {
  id: ID;
  name: string;
  location: string;
  note?: string;
}

/**
 * Everything the app cannot work out from transactions.
 *
 * Deliberately not a will. A will is a legal instrument whose validity turns
 * on state law - how many witnesses, whether one of them may also inherit,
 * whether it was notarised - and a document that looks valid and is not would
 * be discovered at the one moment nobody can fix it. This is the inventory an
 * executor or an attorney asks for first, and the thing a family opens on the
 * worst day of their life to find out what exists and who to call.
 */
export interface EstateRecord {
  policies: Policy[];
  contacts: EstateContact[];
  documents: EstateDocument[];
  /** Who should raise the children. A note to the attorney, not a nomination. */
  guardians?: string;
  /** Anything else worth saying, in their own words. */
  wishes?: string;
  /** The "if something happens to me" forecast, as it was last set up. */
  survivorship?: Survivorship;
  /** When the summary was last looked over, so a stale one can say so. */
  reviewedAt?: ISODate;
}

export interface DB {
  version: number;
  accounts: Account[];
  groups: CategoryGroup[];
  categories: Category[];
  transactions: Transaction[];
  tags: Tag[];
  budgets: Budgets;
  goals: Goal[];
  recurring: Recurring[];
  rules: Rule[];
  holdings: Holding[];
  /**
   * What Hopper has been asked, kept so a thread carries across devices.
   *
   * Questions and answers only — never the tool traffic behind them. Replaying
   * old tool results would spend tokens re-reading figures that have since
   * moved, and the document is pushed whole on every change, so what is stored
   * here is paid for on every sync.
   */
  hopper?: HopperExchange[];
  /** Scenarios for the forecast. Absent until somebody opens it. */
  forecast?: ForecastPlan;
  /** What a family would need to find. Absent until somebody opens it. */
  estate?: EstateRecord;
  settings: Settings;
}

export interface HopperExchange {
  id: ID;
  question: string;
  answer: string;
  used: string[];
  at: string;
}
