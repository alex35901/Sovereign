import type { Account, DB, ID, Transaction } from "../../types.js";
import { compressPoints } from "../history.js";
import { accountKeys } from "./merge.js";
import { itemFor, plainName, sameInstitution } from "./adopt.js";
import type { ItemKind } from "./kind.js";

/**
 * One connection replaced by another at the same bank.
 *
 * A Plaid connection cannot be repaired from the outside. When a bank stops
 * answering Link, the only move left is to disconnect it and connect it again,
 * and that mints a new item: new ids for every account behind the login and
 * new ids for every transaction in them. The merge catches most of it, because
 * an account it cannot find by id it looks for by name and institution. What
 * it cannot catch is a name that has changed on either side — renamed here
 * because "Checking ...4471" is not what anybody calls it, or spelled
 * differently by the bank this time.
 *
 * Then the new login's accounts arrive as new accounts, and the real ones sit
 * beside them holding every transaction, every category, every rule, every
 * goal and nothing that will ever arrive again. Nothing is broken, nothing
 * says anything, and the balance on the account you have always looked at
 * simply stops moving.
 *
 * This is the way back: say which new account is which old one, and the old
 * one takes the new one over. Same account id, so everything hanging off it is
 * untouched; the new connection's ids, so the next pull finds it.
 */

/**
 * A connection, whichever provider it belongs to.
 *
 * The questions asked here are the same for both: which bank is it, when did
 * it last pull, and did that pull fail. Everything the two providers disagree
 * about lives in their own files.
 */
export interface Feeder {
  provider: "plaid" | "teller";
  id: string;
  institution: string;
  kind: ItemKind;
  lastSyncAt?: string;
  lastError?: { message: string; at: string };
}

/** Every connection in the document, both providers, in one shape. */
export function feeders(db: DB): Feeder[] {
  return [
    ...(db.settings.plaidItems ?? []).map((i): Feeder => ({
      provider: "plaid", id: i.itemId, institution: i.institution, kind: i.kind,
      ...(i.lastSyncAt ? { lastSyncAt: i.lastSyncAt } : {}),
      ...(i.lastError ? { lastError: i.lastError } : {}),
    })),
    ...(db.settings.tellerEnrollments ?? []).map((i): Feeder => ({
      // Teller has no notion of what a connection was set up to carry, because
      // a login reaches whatever is behind it. "bank" is what it does.
      provider: "teller", id: i.enrollmentId, institution: i.institution, kind: "bank",
      ...(i.lastSyncAt ? { lastSyncAt: i.lastSyncAt } : {}),
      ...(i.lastError ? { lastError: i.lastError } : {}),
    })),
  ];
}

/** A connection that could be feeding this account, whatever it carries. */
export function feederOf(
  account: Pick<Account, "plaidItemId" | "institution" | "syncSource">,
  all: readonly Feeder[],
): Feeder | undefined {
  const mine = all.filter((f) => !account.syncSource || f.provider === account.syncSource);
  if (account.plaidItemId) {
    const byId = mine.find((f) => f.id === account.plaidItemId);
    if (byId) return byId;
  }
  // By name, for two cases that both look like an orphan and are not: an
  // account added before any pull stamped the connection onto it, and a
  // connection remade in place, which keeps the bank and changes the id.
  //
  // Either product will do. The question here is whether a login to this bank
  // is still here, and an investments-only connection still reports the
  // balance of the chequing account behind it.
  const inst = account.institution ?? "";
  return itemFor(mine, inst, "transactions") ?? itemFor(mine, inst, "investments");
}

/**
 * Why an account is getting nothing, when the app can tell.
 *
 * - `gone`: there is no connection to this bank at all any more. Nothing can
 *   be reattached, because there is nothing to reattach it to: this one wants
 *   the bank connected again first.
 * - `passed-over`: a connection to this bank pulled, cleanly, and did not
 *   touch this account. Which means it is not one of the accounts that login
 *   holds any more, whatever it is called, and the account that is holds the
 *   history this one should have.
 */
/**
 * An account a provider is supposed to be feeding.
 *
 * Both providers, because the repair below is most useful across them: a bank
 * Plaid will not open comes in through Teller as new accounts, and the old
 * ones are left holding the history. Which is the same stranding as any other
 * and wants the same fix.
 */
export const isSynced = (a: Pick<Account, "syncSource">): boolean =>
  a.syncSource === "plaid" || a.syncSource === "teller";

export type Stranding = "gone" | "passed-over";

export interface Stranded {
  account: Account;
  why: Stranding;
}

/**
 * The accounts a connection is no longer feeding.
 *
 * Deliberately evidence-based rather than a guess. `gone` is read off the
 * connection list, and `passed-over` off the clock: a pull writes
 * `lastSyncedAt` on every account it brings back, so an account older than the
 * last clean pull of its own bank was offered and not recognised.
 *
 * Accounts with something to say for themselves are left out. A closed account
 * is settled on purpose and the merge skips it; one the last pull said
 * something about has an explanation already, usually "this bank needs a new
 * login", which is a different repair.
 */
export function strandedIn(db: DB): Stranded[] {
  const all = feeders(db);
  const out: Stranded[] = [];
  for (const account of db.accounts) {
    if (!isSynced(account) || account.closedAt) continue;
    const feeder = feederOf(account, all);
    if (!feeder) {
      out.push({ account, why: "gone" });
      continue;
    }
    // A pull that failed says nothing about which accounts the login holds.
    if (!feeder.lastSyncAt || feeder.lastError) continue;
    if ((account.lastSyncedAt ?? "") >= feeder.lastSyncAt) continue;
    /**
     * Something the provider said about this account in the pull being
     * weighed. That is an explanation of its own and a different repair, so
     * this leaves it to the one giving it.
     *
     * Dated rather than merely present, because nothing clears a note from an
     * account a later pull did not bring back: a bank that spent August
     * failing leaves one on every account it fed, and those are exactly the
     * accounts this is for. A note older than the pull is a note about a
     * connection that is not the one being asked.
     */
    if (account.syncNote && account.syncNote.at >= feeder.lastSyncAt) continue;
    out.push({ account, why: "passed-over" });
  }
  return out;
}

/** An account that could be what a stranded one has become. */
export interface Replacement {
  account: Account;
  /** The connection feeding it. */
  item: Feeder;
  /** Transactions already filed against it, which is what would be folded in. */
  rows: number;
  /** How good a guess this is: higher is better, and 0 is no reason at all. */
  score: number;
}

/**
 * The accounts a live connection is feeding that this one could have become.
 *
 * Same bank and not stranded itself, which leaves the new arrivals. Scored
 * rather than chosen: the name is usually identical in everything but the
 * digits a bank staples on, but it can be anything, and the app has no
 * business deciding this silently when the household knows.
 */
export function replacementsFor(db: DB, stranded: Account): Replacement[] {
  const all = feeders(db);
  const strandedIds = new Set(strandedIn(db).map((s) => s.account.id));
  const out: Replacement[] = [];
  for (const account of db.accounts) {
    if (account.id === stranded.id || account.closedAt) continue;
    if (!isSynced(account) || strandedIds.has(account.id)) continue;
    const item = feederOf(account, all);
    if (!item) continue;
    if (!sameInstitution(account.institution ?? "", stranded.institution ?? "")) continue;
    out.push({
      account,
      item,
      rows: db.transactions.reduce((n, t) => n + (t.accountId === account.id ? 1 : 0), 0),
      score: scoreOf(stranded, account),
    });
  }
  return out.sort((a, b) => b.score - a.score || a.account.name.localeCompare(b.account.name));
}

/**
 * How much two accounts look like the same account.
 *
 * The type is worth most: a chequing account is never a credit card, whatever
 * either is called. Then the name, whole or one inside the other, because a
 * bank that said "Everyday Checking" last time says "Everyday Checking ...4471"
 * this time. The balance breaks the tie between two savings accounts, and
 * breaks it on being close rather than equal: a day has usually passed.
 */
export function scoreOf(a: Account, b: Account): number {
  let score = 0;
  if (a.type === b.type) score += 4;
  const x = plainName(a.name);
  const y = plainName(b.name);
  if (x && y) {
    if (x === y) score += 4;
    else if (x.includes(y) || y.includes(x)) score += 3;
    else {
      // Words in common, which catches a bank that reorders them or drops one.
      const words = new Set(x.split(" ").filter((w) => w.length > 2));
      const shared = y.split(" ").filter((w) => w.length > 2 && words.has(w)).length;
      if (shared) score += 2;
    }
  }
  // Last four digits, where either name carries them. They are the one part of
  // an account name that is the account rather than a description of it.
  const tail = (s: string) => s.match(/(\d{4})\D*$/)?.[1];
  const ta = tail(a.name);
  if (ta && ta === tail(b.name)) score += 4;
  if (a.balance === b.balance) score += 2;
  else if (Math.abs(a.balance - b.balance) <= Math.max(5_00, Math.abs(a.balance) / 50)) score += 1;
  return score;
}

/** The pairing to offer, where one candidate is clearly ahead of the rest. */
export function suggestedPairs(db: DB): { strandedId: ID; intoId: ID }[] {
  const taken = new Set<ID>();
  const out: { strandedId: ID; intoId: ID }[] = [];
  // Best first across all of them, so the strongest match claims its
  // replacement before a weaker one can take it.
  const all = strandedIn(db)
    .map((s) => ({ stranded: s.account, best: replacementsFor(db, s.account) }))
    .sort((a, b) => (b.best[0]?.score ?? 0) - (a.best[0]?.score ?? 0));
  for (const { stranded, best } of all) {
    const pick = best.find((r) => !taken.has(r.account.id));
    if (!pick) continue;
    // A guess worth making needs the type or the name behind it, and needs to
    // be better than the runner-up. Two identical savings accounts is exactly
    // the case to leave to the household.
    const next = best.find((r) => r.account.id !== pick.account.id && !taken.has(r.account.id));
    if (pick.score < 6 || (next && next.score === pick.score)) continue;
    taken.add(pick.account.id);
    out.push({ strandedId: stranded.id, intoId: pick.account.id });
  }
  return out;
}

export interface Folded {
  db: DB;
  /** Rows that moved across to the account that was kept. */
  moved: number;
  /** Rows the kept account already had, now carrying the new connection's id. */
  rekeyed: number;
  /** Holdings replaced wholesale, a snapshot being a snapshot. */
  holdings: number;
}

/**
 * Fold the new account into the old one, and keep the old one.
 *
 * Which way round this goes is the whole point. The old account is the one the
 * budget, the rules, the goals, the notes and two years of categorised
 * transactions are attached to, so it is the one that survives; the new one is
 * a few hours old and has nothing but an id the bank recognises. So the old
 * account takes that id, and the new account is dismantled into it.
 *
 * Nothing is tombstoned. A tombstone is a memory of an account that is gone,
 * and this one is not gone: it is the account being looked at, under the id
 * the connection now uses. Remembering it would have the next pull turn the
 * account away at the door and say nothing at all.
 */
export function foldInto(db: DB, keepId: ID, dropId: ID): Folded {
  const keep = db.accounts.find((a) => a.id === keepId);
  const drop = db.accounts.find((a) => a.id === dropId);
  if (!keep || !drop || keepId === dropId) return { db, moved: 0, rekeyed: 0, holdings: 0 };

  /**
   * The same transaction under two ids.
   *
   * Both connections pulled the same days, so a fortnight of rows is usually
   * held twice: once on the old account with whatever was put on it, and once
   * on the new one with nothing. Matched on the day and the figure, the way
   * the merge matches a connection remade in place, and claimed rather than
   * found, because two five dollar coffees on one Tuesday are two rows.
   */
  const twinKey = (date: string, amount: number) => `${date}|${amount}`;
  const twins = new Map<string, Transaction[]>();
  for (const t of db.transactions) {
    if (t.accountId !== keepId) continue;
    const k = twinKey(t.date, t.amount);
    const held = twins.get(k);
    if (held) held.push(t);
    else twins.set(k, [t]);
  }

  /** What the kept account's matching row should now be keyed as. */
  const rekey = new Map<ID, Partial<Transaction>>();
  const discard = new Set<ID>();
  let moved = 0;
  for (const t of db.transactions) {
    if (t.accountId !== dropId) continue;
    const twin = twins.get(twinKey(t.date, t.amount))?.shift();
    if (twin && t.importKey) {
      // The household's copy keeps the category, the merchant, the notes and
      // the tags, and takes the new connection's id for the row so the next
      // pull recognises it. The new copy is the one that goes.
      rekey.set(twin.id, {
        importKey: t.importKey,
        ...(twin.pending && !t.pending ? { pending: false, statement: t.statement } : {}),
      });
      discard.add(t.id);
      continue;
    }
    if (twin) {
      // No id to inherit, so there is nothing to gain by swapping them.
      discard.add(t.id);
      continue;
    }
    moved += 1;
  }

  const transactions = db.transactions
    .filter((t) => !discard.has(t.id))
    .map((t) => {
      const patch = rekey.get(t.id);
      if (patch) return { ...t, ...patch };
      return t.accountId === dropId ? { ...t, accountId: keepId } : t;
    });

  // Positions are a snapshot rather than a ledger, so the live connection's
  // are the whole truth and the stranded account's are as old as its last
  // pull. Only when there are some: a bank connection reports no holdings at
  // all, and that is not the same as an empty brokerage.
  const fresh = db.holdings.filter((h) => h.accountId === dropId);
  const holdings = fresh.length
    ? db.holdings.filter((h) => h.accountId !== keepId).map((h) => (h.accountId === dropId ? { ...h, accountId: keepId } : h))
    : db.holdings.filter((h) => h.accountId !== dropId);

  // The new account's figures, which came from the connection that is still
  // answering, over the stranded one's, which stopped at whenever it stopped.
  const history = compressPoints(
    [...keep.history.filter((h) => !drop.history.some((d) => d.date === h.date)), ...drop.history]
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  );

  const merged: Account = {
    ...keep,
    balance: drop.balance,
    history,
    // The provider that is actually feeding it now, which is the whole point
    // when the fold is across providers: a Plaid account that has moved onto
    // Teller must stop saying Plaid, or nothing will ever look for it there.
    syncSource: drop.syncSource ?? keep.syncSource,
    syncId: drop.syncId,
    plaidItemId: drop.plaidItemId,
    lastSyncedAt: drop.lastSyncedAt ?? keep.lastSyncedAt,
    // What it used to answer to, in case the old connection is ever restored:
    // without this the merge would meet the old id, recognise nothing, and
    // make a second copy of the account it had just been handed back.
    movedFrom: [...new Set([...(keep.movedFrom ?? []), ...(drop.movedFrom ?? []), keep.syncId].filter(Boolean) as string[])]
      .filter((id) => id !== drop.syncId),
    logo: keep.logo ?? drop.logo,
    domain: keep.domain ?? drop.domain,
    syncNote: undefined,
  };

  // Whatever the household deleted that this account now answers to. Leaving
  // it would have every later pull turn the account away in silence.
  const buried = new Set(accountKeys({ syncId: drop.syncId, name: drop.name, institution: drop.institution }));
  const held = db.settings.deletedAccountKeys ?? [];
  const tombstones = held.filter((k) => !buried.has(k));

  return {
    db: {
      ...db,
      accounts: db.accounts
        .filter((a) => a.id !== dropId)
        .map((a) => (a.id === keepId ? merged : a)),
      transactions,
      holdings,
      // Anything else that named the account being dismantled. A few hours old
      // it will not have been named by any of these, and repointing them costs
      // nothing and is the difference between a fold and a quiet data loss.
      recurring: db.recurring.map((r) => (r.accountId === dropId ? { ...r, accountId: keepId } : r)),
      rules: db.rules.map((r) => (
        r.criteria.accountId === dropId ? { ...r, criteria: { ...r.criteria, accountId: keepId } } : r
      )),
      goals: db.goals.map((g) => {
        const listed = g.accountIds.includes(dropId);
        const allocated = g.allocations?.[dropId] !== undefined;
        if (!listed && !allocated) return g;
        const accountIds = listed
          ? [...new Set(g.accountIds.map((id) => (id === dropId ? keepId : id)))]
          : g.accountIds;
        let allocations = g.allocations;
        if (allocated) {
          const { [dropId]: amount, ...rest } = g.allocations!;
          allocations = { ...rest, [keepId]: (rest[keepId] ?? 0) + (amount ?? 0) };
        }
        return { ...g, accountIds, allocations };
      }),
      settings: tombstones.length === held.length
        ? db.settings
        : { ...db.settings, deletedAccountKeys: tombstones },
    },
    moved,
    rekeyed: rekey.size,
    holdings: fresh.length,
  };
}
