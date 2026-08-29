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
  /** Sparse snapshots, ascending by date; forward-filled when charting. */
  history: { date: ISODate; balance: number }[];
  syncSource?: "manual" | "csv" | "simplefin" | "plaid";
  syncId?: string;
  lastSyncedAt?: string;
  /** Street address, for property accounts that can be valued automatically. */
  address?: string;
  /** The most recent automated valuation, kept for provenance. */
  valuation?: { source: "rentcast"; low?: number; high?: number; at: string };
  /** Depreciation inputs for a vehicle account. */
  vehicle?: VehicleProfile;
  order: number;
}

export type GroupKind = "income" | "expense" | "transfer";

export interface CategoryGroup { id: ID; name: string; kind: GroupKind; order: number }

export interface Category {
  id: ID;
  groupId: ID;
  name: string;
  icon: string;
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
  accountIds: ID[];
  /** Manual starting contribution when no account is linked. */
  startingAmount: number;
  monthlyContribution: number;
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
  /** Connected Plaid items. Credentials for Plaid itself live server-side. */
  plaidItems?: PlaidItemRef[];
  lastSyncAt?: string;
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
  goals: Goal[];
  recurring: Recurring[];
  rules: Rule[];
  holdings: Holding[];
  settings: Settings;
}
