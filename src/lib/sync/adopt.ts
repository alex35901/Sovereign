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
    // What it used to answer to. The old connection keeps offering this
    // account every night under that id, and without this the merge meets
    // something it has never seen and makes a second copy of it.
    movedFrom: [...new Set([...(account.movedFrom ?? []), account.syncId].filter(Boolean) as string[])],
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

/** Names differ in punctuation and in how much of the bank they spell out. */
const norm = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * The words that say what kind of institution it is rather than which one.
 *
 * One provider calls it "Elements Financial", another "Elements Financial
 * Credit Union", a statement "Elements Financial, Inc." Strip these and all
 * three say the same thing.
 */
const GENERIC = new Set([
  "bank", "banking", "credit", "union", "fcu", "cu", "federal",
  "financial", "finance", "savings", "trust", "na",
  "inc", "incorporated", "llc", "co", "company", "corp", "corporation",
  "the", "of", "and",
]);

/** What is left of a name once the kind of institution is taken out of it. */
const core = (s: string): string[] => {
  const all = norm(s).split(" ").filter(Boolean);
  const named = all.filter((w) => !GENERIC.has(w));
  // A name that is nothing but generic words is all it has, so it keeps them.
  return named.length ? named : all;
};

const within = (a: readonly string[], b: readonly string[]): boolean => a.every((w) => b.includes(w));

/**
 * The connection already held for this bank, if there is one.
 *
 * A Plaid connection is one login, not one account: the same item holds every
 * account behind it. Opening a second one for the savings account beside the
 * chequing account costs a second of the plan's ten connections, and then both
 * items return both accounts and take turns renaming each other's ids.
 *
 * Matched on what is left of the name once the kind of institution is taken
 * out of it, because the account being moved came from somewhere else and two
 * providers rarely spell a credit union the same way. Loose is safe here: the
 * answer is only ever a suggestion, the accounts behind that login are shown
 * before anything is chosen, and a different login is one press away.
 */
export function itemFor<T extends { institution: string; kind: "bank" | "investment" }>(
  items: readonly T[],
  institution: string,
  kind: "bank" | "investment" = "bank",
): T | undefined {
  const want = core(institution);
  // Too little to be a name. Matching on it would match everything.
  if (want.join("").length < 4) return undefined;
  return items.find((i) => {
    if (i.kind !== kind) return false;
    const held = core(i.institution);
    if (held.join("").length < 4) return false;
    return within(want, held) || within(held, want);
  });
}
