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
  /**
   * Things the pull wants on the record that are not faults.
   *
   * A mortgage carries no transactions and never will, and saying so belongs
   * on that account rather than in the column that decides whether the whole
   * provider is failing. Kept apart from `errors` because that is the one
   * thing a reader cannot tell from the sentence itself: both are prose, and
   * only one of them means something is broken.
   */
  notes?: string[];
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
/**
 * A pull the scheduled job left for a browser to open.
 *
 * The source travels with it because the browser has to decide whether to
 * merge it, and the two providers are merged on different terms. A payload
 * that names no source at all predates this and is dropped rather than
 * guessed at.
 */
export type QueuedPayload = SyncPayload & {
  source?: "plaid" | "simplefin";
  /**
   * The connection this payload is about, when it carries no accounts.
   *
   * A pull that failed outright has nothing to be matched by: the browser
   * decides whether to merge a payload by looking at the connections its
   * accounts name, and a pull that brought none names nobody. Without this a
   * card whose login expired goes quiet, the reason is thrown away unopened,
   * and the only sign left is a balance that stops moving.
   */
  itemId?: string;
};

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
