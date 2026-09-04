import type { SyncCadence } from "./lib/sync/schedule.js";
/** All money is integer cents. Outflows are negative, inflows positive. */
export type ID = string;
export type ISODate = string; // YYYY-MM-DD
export type MonthKey = string; // YYYY-MM

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
  /** Closed on this date: balance zeroed, history kept, sync stops touching it. */
  closedAt?: ISODate;
  /** Sparse snapshots, ascending by date; forward-filled when charting. */
  history: { date: ISODate; balance: number }[];
  /** The institution's logo as a data URI, when the provider supplies one. */
  logo?: string;
  /** The institution's website, used to look a logo up when it doesn't. */
  domain?: string;
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

/**
 * A standing amount for a category, applying from `from` onwards unless that
 * month has an explicit entry in `budgets`. This is what "apply to all future
 * months" sets — writing to every month individually would only ever cover the
 * months that happen to exist yet.
 */
export type BudgetDefaults = Record<ID, { amount: number; from: MonthKey }>;

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
}

export interface Settings {
  theme: "dark" | "light";
  currency: string;
  privacyMode: boolean;
  startPage: string;
  householdName: string;
  /** SimpleFIN access URL, stored locally. Empty until the user connects. */
  simplefinAccessUrl?: string;
  /** RentCast API key for property valuations, stored locally. */
  rentcastApiKey?: string;
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

export interface DB {
  version: number;
  accounts: Account[];
  groups: CategoryGroup[];
  categories: Category[];
  transactions: Transaction[];
  tags: Tag[];
  budgets: Budgets;
  budgetDefaults?: BudgetDefaults;
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
  settings: Settings;
}

export interface HopperExchange {
  id: ID;
  question: string;
  answer: string;
  used: string[];
  at: string;
}
