import type { Account, DB, ISODate } from "../../types.js";
import { addDays } from "../date.js";

/**
 * Moving an account from one provider to another without losing it.
 *
 * Connecting the same bank through Plaid makes a second account: new ids, new
 * name, and every transaction arriving under a key nothing recognises. The
 * budget, the rules, the goals, the splits and the notes are all attached to
 * the account that already exists, so the useful operation is not "add" but
 * "this new connection is that account".
 *
 * Which means keeping the account's own id and changing only where its data
 * comes from. Nothing else in the document has to know anything happened.
 */

/**
 * The day after the newest transaction this account already holds.
 *
 * The floor the new provider starts at. Day after, not the same day: a
 * provider that files the same day again would file a second copy of
 * everything on it, and a day of overlap is the one day most likely to be
 * duplicated rather than the one most likely to be missing.
 */
export function floorFor(db: DB, accountId: string, fallback: ISODate): ISODate {
  const newest = db.transactions
    .filter((t) => t.accountId === accountId)
    .reduce<string | null>((best, t) => (best === null || t.date > best ? t.date : best), null);
  return newest ? addDays(newest, 1) : fallback;
}

export interface Adoption {
  /** The Plaid account this one becomes. */
  syncId: string;
  /** The item it now belongs to. */
  institution: string;
  logo?: string;
  domain?: string;
}

/**
 * The account, now fed by the new provider.
 *
 * The id, the name, the type, the history, the balance and everything hanging
 * off it are untouched: this is the same account, reached a different way. Only
 * the provider, its id for the account, and the day its history starts.
 */
export function adopt(account: Account, to: Adoption, from: ISODate): Account {
  return {
    ...account,
    syncSource: "plaid",
    syncId: to.syncId,
    syncFrom: from,
    // The institution's own mark, if the new provider has one and the account
    // has none. The name is left alone: it is the household's label for this
    // account, and two providers rarely agree on what a chequing account is
    // called.
    logo: account.logo ?? to.logo,
    domain: account.domain ?? to.domain,
    // Whatever the old provider last complained about is no longer true of
    // this account, because it is no longer that provider's.
    syncNote: undefined,
  };
}
