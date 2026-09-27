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
  /** Institution logo, as a data URI. Plaid returns one; not every source does. */
  logo?: string;
  /** Institution website, which a logo can be looked up from when there is none. */
  domain?: string;
  /**
   * The Plaid connection this account came in through.
   *
   * Written onto the account so that "which accounts are behind this login" is
   * an answer rather than a guess. It cannot be worked out from the name: an
   * account moved to Plaid from somewhere else keeps the name and institution
   * the household already gave it, deliberately, so the two spellings rarely
   * match. Absent for a source that has no such thing.
   */
  itemId?: string;
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
  /**
   * The pending row this one settles, when the provider issues a new id for it.
   *
   * Plaid does: a pending charge and the posted charge it becomes are two
   * different transaction ids, joined only by this. Without it the pending one
   * is never recognised again and the account carries both - the hold and the
   * charge - for ever.
   */
  replacesSyncId?: string;
}

export interface SyncPayload {
  accounts: RemoteAccount[];
  transactions: RemoteTransaction[];
  errors: string[];
  fetchedAt: string;
}

/**
 * A pull left in the queue for an encrypted document.
 *
 * The scheduled job cannot merge into an envelope, so it seals each pull to the
 * document's public key and a browser applies it later. The source rides along
 * because a payload that does not say it is Plaid's is not merged at all: the
 * queue can still be holding one sealed by an older job, and the only other
 * thing that ever wrote to it was a bridge whose pulls must never land.
 */
export type QueuedPayload = SyncPayload & { source?: "plaid" };

export interface SyncAdapter {
  id: "plaid" | "teller";
  label: string;
  /** One-line cost note shown in Settings. */
  cost: string;
  /** True when the user has finished connecting this provider. */
  isConnected: (settings: Record<string, unknown>) => boolean;
  /** Exchange a one-time setup token for durable credentials. */
  connect: (token: string) => Promise<{ accessUrl: string }>;
  /** Pull accounts + transactions since `since` (ISO date). */
  fetch: (accessUrl: string, since: string) => Promise<SyncPayload>;
}

/** A source that reports no account type leaves the name to infer one from. */
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
