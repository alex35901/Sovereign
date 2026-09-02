import type { Account, AccountType } from "../../types.js";

export interface RemoteAccount {
  /** Stable id from the provider — how we re-find this account on later syncs. */
  syncId: string;
  name: string;
  institution: string;
  /** Signed cents; liabilities negative. */
  balance: number;
  currency: string;
  type: AccountType;
  balanceDate: string;
  /** Institution logo, as a data URI. Plaid returns one; SimpleFIN does not. */
  logo?: string;
  /** Institution website, which a logo can be looked up from when there is none. */
  domain?: string;
}

export interface RemoteTransaction {
  syncId: string;
  accountSyncId: string;
  date: string;
  amount: number;
  description: string;
  payee?: string;
  memo?: string;
  pending: boolean;
}

export interface SyncPayload {
  accounts: RemoteAccount[];
  transactions: RemoteTransaction[];
  errors: string[];
  fetchedAt: string;
}

export interface SyncAdapter {
  id: "simplefin" | "plaid" | "teller";
  label: string;
  /** One-line cost note shown in Settings. */
  cost: string;
  /** True when the user has finished connecting this provider. */
  isConnected: (settings: { simplefinAccessUrl?: string }) => boolean;
  /** Exchange a one-time setup token for durable credentials. */
  connect: (token: string) => Promise<{ accessUrl: string }>;
  /** Pull accounts + transactions since `since` (ISO date). */
  fetch: (accessUrl: string, since: string) => Promise<SyncPayload>;
}

/** SimpleFIN reports no account type, so infer one from the name. */
export function guessAccountType(name: string, balance: number): AccountType {
  const n = name.toLowerCase();
  if (/(visa|mastercard|amex|credit|card)/.test(n)) return "credit";
  if (/(401|403b|ira|roth|pension|retirement)/.test(n)) return "retirement";
  if (/(brokerage|invest|trading|securities)/.test(n)) return "investment";
  if (/(mortgage)/.test(n)) return "mortgage";
  if (/(loan|auto|student)/.test(n)) return "loan";
  if (/(save|saving|money market|hysa)/.test(n)) return "savings";
  if (/(check|checking|debit)/.test(n)) return "checking";
  return balance < 0 ? "other_liability" : "checking";
}

export const accountMatchesRemote = (a: Account, r: RemoteAccount): boolean =>
  a.syncId === r.syncId || (a.name === r.name && a.institution === r.institution);
