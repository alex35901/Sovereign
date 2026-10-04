import type { Account, CardRewards, DB, EarnRule, ID, ISODate, SignupBonus } from "../types.js";
import { addDays, dateLabel, monthEnd, monthOf, parseISO, today } from "./date.js";
import { fmt } from "./money.js";
import { categoryKind, counts, lines, merchantIndex, merchantKey, mutedAccountIds } from "./select.js";

/**
 * What a wallet of cards actually earns, against the spending that happened.
 *
 * The app knows nothing about card products and does not try to: no catalogue
 * of what a Venture X pays, no offer terms, nothing that goes stale in a
 * drawer. What it knows is every purchase, what it was for, and which card it
 * landed on. Given the one missing input - what each card pays - the rest is
 * arithmetic on real money rather than an estimate.
 *
 * Caps are here from the start because leaving them out would flatter every
 * capped card on the page. "Five percent on the first fifteen hundred a
 * quarter" is worth seventy-five dollars a quarter however much is spent, and
 * a comparison that missed that would recommend the wrong card to somebody who
 * spends more than the cap - which is most people who bother to ask.
 */

export const DEFAULT_REWARDS: CardRewards = { pointCents: 1, base: 1, rules: [] };

export const rewardsOf = (a: Account): CardRewards => a.rewards ?? DEFAULT_REWARDS;

/** Has anybody actually said what this card pays, or is it still the default? */
export const isSet = (a: Account): boolean => !!a.rewards;

/** The cards a wallet holds: open, visible, and a card. */
export function cardAccounts(db: DB): Account[] {
  return db.accounts
    .filter((a) => a.type === "credit" && !a.hidden && !a.closedAt)
    .sort((x, y) => x.order - y.order);
}

/** One purchase, as the earn engine reads it. */
export interface SpendLine {
  date: ISODate;
  categoryId: ID;
  /**
   * Who it was paid to, as the ledger spells it.
   *
   * Carried on the line rather than looked up later because the routing walks
   * these in date order under a shared set of caps: asking afterwards which
   * card a merchant's purchases went to would mean a second walk, and a
   * second walk would hand every merchant a fresh cap.
   */
  merchant: string;
  /** Positive cents. Outflows arrive negative and are turned here. */
  amount: number;
}

/**
 * Which bucket a cap is counted in.
 *
 * A cap with no period never resets, so everything falls in one bucket and it
 * is spent once and for all.
 */
function capKey(rule: EarnRule, date: ISODate): string {
  if (!rule.period) return "all";
  if (rule.period === "month") return monthOf(date);
  if (rule.period === "year") return date.slice(0, 4);
  return `${date.slice(0, 4)}Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3)}`;
}

/** The rules that claim a category, best rate first. */
/**
 * The rules a purchase earns, best first.
 *
 * Either list claims it. Matching a shop by the same key the rest of the app
 * groups merchants under, so a rule naming "Amazon" claims a charge the bank
 * spelled "AMAZON" without the household having to spell it the bank's way.
 */
const claiming = (r: CardRewards, line: { categoryId: ID; merchant?: string }): EarnRule[] => {
  const who = merchantKey(line.merchant ?? "");
  return r.rules
    .filter((x) => x.categoryIds.includes(line.categoryId)
      || (!!who && (x.merchants ?? []).some((m) => merchantKey(m) === who)))
    .sort((a, b) => b.rate - a.rate);
};

/**
 * What these purchases earn on this card, in cents of value.
 *
 * Walked in date order because that is the order a cap fills in: the issuer
 * pays the bonus until the limit is reached and the base rate after it, and
 * which purchases fall on which side of that line is a question about when
 * they happened.
 *
 * A purchase can be split across a cap - part of it inside, the rest at base -
 * which is what actually happens on the statement that straddles the limit.
 */
export function earnDetail(rewards: CardRewards, spend: readonly SpendLine[]) {
  const used = new Map<string, number>();
  const byCategory = new Map<ID, number>();
  const byMerchant = new Map<string, number>();
  let points = 0;
  // rate is per dollar and amounts are cents, so the product is points per
  // cent; pointCents turns points into cents of value.
  const value = (p: number) => Math.round((p / 100) * rewards.pointCents);

  for (const line of [...spend].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    let left = line.amount;
    let here = 0;
    for (const rule of claiming(rewards, line)) {
      if (left <= 0) break;
      if (rule.cap === undefined) { here += left * rule.rate; left = 0; break; }
      const key = `${rule.id}:${capKey(rule, line.date)}`;
      const room = Math.max(0, rule.cap - (used.get(key) ?? 0));
      const at = Math.min(left, room);
      if (at <= 0) continue;
      used.set(key, (used.get(key) ?? 0) + at);
      here += at * rule.rate;
      left -= at;
    }
    here += left * rewards.base;
    points += here;
    byCategory.set(line.categoryId, (byCategory.get(line.categoryId) ?? 0) + here);
    const who = merchantKey(line.merchant ?? "");
    if (who) byMerchant.set(who, (byMerchant.get(who) ?? 0) + here);
  }

  // Rounded once at the end for the total and once per category, so a table of
  // categories can be a cent or two off the headline. Rounding each purchase
  // instead would be off by more, and in the same direction every time.
  return {
    total: value(points),
    /**
     * The same earning counted in the card's own points rather than in money.
     *
     * `points` above is per cent, because rate is per dollar and amounts are
     * cents. A hundredth of that is the figure the issuer's statement shows.
     */
    points: Math.round(points / 100),
    /**
     * How much of each capped rule has been spent, by the bucket it fell in.
     *
     * Keyed the way the walk keys it, `rule:bucket`, and handed back rather
     * than thrown away so the page can say how much of a quarterly cap is
     * still open. Only ever as complete as the window it was walked over.
     */
    used,
    byCategory: new Map([...byCategory].map(([id, p]) => [id, value(p)])),
    byMerchant: new Map([...byMerchant].map(([who, p]) => [who, value(p)])),
  };
}

export const earned = (rewards: CardRewards, spend: readonly SpendLine[]): number =>
  earnDetail(rewards, spend).total;

/* ── what the wallet earned, and what it could have ────────────────────── */

export interface CardLine {
  accountId: ID;
  name: string;
  /** Spend that actually went on it, in the window. */
  spend: number;
  /** What that spend earned, in cents of value. */
  earned: number;
  annualFee: number;
  /** Its own rate on everything nothing else claims, as cents per dollar. */
  base: number;
  /** Whether a person has checked these terms, and when. */
  confirmedAt?: string;
  set: boolean;
  /** What that spend earned in the card's own points, rather than in money. */
  points: number;
  /** The capped rules on it, and how much room each has left in the bucket we are in. */
  caps: CapRoom[];
  /** Interest this card charged in the window, when it charged any. */
  interest: number;
  /** How far along its sign-up bonus is, when it has one. */
  bonus?: BonusProgress;
}

export interface CategoryLine {
  categoryId: ID;
  spend: number;
  /** What it earned where it actually went. */
  earned: number;
  /** What it would have earned on the best card held. */
  best: number;
  /** Never negative: the best routing is never worse than the one taken. */
  gap: number;
  /** The card the best routing put most of this category on. */
  bestAccountId?: ID;
}

/**
 * The same question as a CategoryLine, asked of one shop rather than one kind
 * of spending.
 *
 * Worth asking separately because cards are not sold by category. A card that
 * pays five percent at one chain and one percent everywhere else is invisible
 * in a table of categories, where that chain is a slice of "Shopping" sitting
 * next to forty other shops; against the shop itself it is the whole line.
 */
export interface MerchantLine {
  /** The lowercased name the rest of the app groups merchants by. */
  key: string;
  /** The spelling to show, which is the one the merchants page shows. */
  name: string;
  spend: number;
  earned: number;
  best: number;
  gap: number;
  bestAccountId?: ID;
  /**
   * The kind of spending most of this shop's money was filed under.
   *
   * So the two tables can be read together rather than added up. A grocery
   * category whose whole miss is one supermarket is the supermarket's line
   * said twice, and only one of the two is worth putting in front of anybody.
   */
  categoryId?: ID;
}

export interface CardReport {
  from: ISODate;
  to: ISODate;
  cards: CardLine[];
  categories: CategoryLine[];
  /** The shops themselves, biggest miss first, as the categories are. */
  merchants: MerchantLine[];
  totals: { spend: number; earned: number; best: number; gap: number };
  /** The card to reach for when nothing has a bonus, and what it pays. */
  driver?: { accountId: ID; name: string; rate: number };
  /**
   * Spend that never went near a card.
   *
   * Kept out of the headline on purpose. A mortgage, a tax bill and the water
   * rates are the biggest things a household pays and most of them cannot go
   * on a card at all, so counting them as money left on the table would put a
   * number at the top of the page that nobody could ever collect - and would
   * bury the one they could under it.
   */
  offCard: { spend: number; could: number };
}

/**
 * The best card for each purchase, decided purchase by purchase in date order.
 *
 * Not the theoretical optimum: choosing the assignment that maximises the
 * total across a year of caps is a packing problem, and nobody standing at a
 * till is solving one. This is the decision a person can actually make - reach
 * for whichever card pays most for this, now, given what the caps have already
 * taken - which makes the figure it produces one somebody could have achieved.
 */
function bestRouting(cards: { id: ID; rewards: CardRewards }[], spend: readonly SpendLine[]) {
  const used = new Map<string, number>();
  const byCategory = new Map<ID, { best: number; on: Map<ID, number> }>();
  const byMerchant = new Map<string, { best: number; on: Map<ID, number> }>();
  const byCard = new Map<ID, number>();
  let total = 0;

  /**
   * What this card would pay for this purchase, given what its caps have
   * already taken, and what that would cost each of those caps.
   *
   * Split at the cap exactly as earnDetail splits it. Valuing the whole
   * purchase at the bonus rate whenever the cap had a dollar left in it was
   * the bug this replaces: a two-thousand-dollar shop against a thousand of
   * remaining cap was priced at five percent of all of it, so the page
   * promised a saving no card would ever have paid.
   */
  const valueOn = (c: { id: ID; rewards: CardRewards }, line: SpendLine) => {
    const charges: { key: string; amount: number }[] = [];
    let left = line.amount;
    let points = 0;
    for (const rule of claiming(c.rewards, line)) {
      if (left <= 0) break;
      if (rule.cap === undefined) { points += left * rule.rate; left = 0; break; }
      const key = `${c.id}:${rule.id}:${capKey(rule, line.date)}`;
      const room = Math.max(0, rule.cap - (used.get(key) ?? 0));
      const at = Math.min(left, room);
      if (at <= 0) continue;
      charges.push({ key, amount: at });
      points += at * rule.rate;
      left -= at;
    }
    points += left * c.rewards.base;
    return { value: points * c.rewards.pointCents, charges };
  };

  for (const line of [...spend].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    let pick = null as null | { id: ID; value: number; charges: { key: string; amount: number }[] };
    for (const c of cards) {
      const { value, charges } = valueOn(c, line);
      if (!pick || value > pick.value) pick = { id: c.id, value, charges };
    }
    if (!pick) continue;
    // Charged against the caps it was paid from, so the next purchase sees a
    // wallet in the state this one left it.
    for (const ch of pick.charges) used.set(ch.key, (used.get(ch.key) ?? 0) + ch.amount);
    const value = Math.round(pick.value / 100);
    total += value;
    const at = byCategory.get(line.categoryId) ?? { best: 0, on: new Map<ID, number>() };
    at.best += value;
    at.on.set(pick.id, (at.on.get(pick.id) ?? 0) + line.amount);
    byCategory.set(line.categoryId, at);
    // The same decision, filed by who it was paid to. One pass, so the caps a
    // purchase spends are spent once however the answer is later cut up, and
    // the two tables on the page cannot disagree about which card to reach for.
    const who = merchantKey(line.merchant ?? "");
    if (who) {
      const here = byMerchant.get(who) ?? { best: 0, on: new Map<ID, number>() };
      here.best += value;
      here.on.set(pick.id, (here.on.get(pick.id) ?? 0) + line.amount);
      byMerchant.set(who, here);
    }
    byCard.set(pick.id, (byCard.get(pick.id) ?? 0) + line.amount);
  }
  return { total, byCategory, byMerchant, byCard };
}

/** Which card the routing leaned on for a category, by spend rather than count. */
const leader = (on: Map<ID, number>): ID | undefined =>
  [...on.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

/**
 * Everything the cards page needs, over one window.
 *
 * Spending is read the way every other report reads it: splits are separate
 * lines, hidden accounts and rows are out, and anything categorised as a
 * transfer is out, which is what keeps a card payment from counting as a
 * purchase on the card it clears.
 */
/**
 * Every purchase in the window, split by whether a card was involved.
 *
 * One walk, shared, because more than one thing on this page asks the same
 * question of the same transactions and two walks would be two places for
 * "what counts as spending" to drift apart.
 */
function walkSpend(db: DB, from: ISODate, to: ISODate) {
  const onCard = new Set(cardAccounts(db).map((a) => a.id));
  const muted = mutedAccountIds(db);
  const carded: SpendLine[] = [];
  const elsewhere: SpendLine[] = [];
  const byCard = new Map<ID, SpendLine[]>();
  const spent = new Map<ID, number>();
  const spentAt = new Map<string, number>();
  const catAt = new Map<string, Map<ID, number>>();

  for (const t of db.transactions) {
    if (t.date < from || t.date > to || !counts(t, muted)) continue;
    for (const l of lines(t)) {
      // Only money going out, and only on something that is really a purchase.
      if (l.amount >= 0 || categoryKind(db, l.categoryId) === "transfer") continue;
      const line: SpendLine = {
        date: t.date, categoryId: l.categoryId, merchant: t.merchant, amount: -l.amount,
      };
      if (onCard.has(t.accountId)) {
        carded.push(line);
        spent.set(l.categoryId, (spent.get(l.categoryId) ?? 0) + line.amount);
        const who = merchantKey(t.merchant);
        if (who) {
          spentAt.set(who, (spentAt.get(who) ?? 0) + line.amount);
          const kinds = catAt.get(who) ?? new Map<ID, number>();
          kinds.set(l.categoryId, (kinds.get(l.categoryId) ?? 0) + line.amount);
          catAt.set(who, kinds);
        }
        const at = byCard.get(t.accountId) ?? [];
        at.push(line);
        byCard.set(t.accountId, at);
      } else {
        elsewhere.push(line);
      }
    }
  }
  return { carded, elsewhere, byCard, spent, spentAt, catAt };
}

/** What went on a card in the window, for anything weighing one card against another. */
export const cardedSpend = (db: DB, from: ISODate, to: ISODate): SpendLine[] =>
  walkSpend(db, from, to).carded;

/** What went on one card, over a window of its own. */
export const spendOnCard = (db: DB, accountId: ID, from: ISODate, to: ISODate): SpendLine[] =>
  walkSpend(db, from, to).byCard.get(accountId) ?? [];

export function cardReport(
  db: DB,
  from: ISODate,
  to: ISODate,
  /** The day the caps and the bonus deadlines are read against. */
  now: ISODate = today(),
): CardReport {
  const accounts = cardAccounts(db);
  const wallet = accounts.map((a) => ({ id: a.id, rewards: rewardsOf(a) }));
  const { carded, elsewhere, byCard, spent, spentAt, catAt } = walkSpend(db, from, to);

  // What was actually earned, card by card, and per category and per merchant
  // so the tables can set what was earned beside what could have been.
  const actualByCategory = new Map<ID, number>();
  const actualByMerchant = new Map<string, number>();
  const cards: CardLine[] = accounts.map((a) => {
    const r = rewardsOf(a);
    const mine = byCard.get(a.id) ?? [];
    // One walk for the card and its categories together. Walking each category
    // on its own would hand every one of them a fresh cap, and a rule that
    // spans two categories would be paid twice over.
    const detail = earnDetail(r, mine);
    for (const [categoryId, got] of detail.byCategory) {
      actualByCategory.set(categoryId, (actualByCategory.get(categoryId) ?? 0) + got);
    }
    for (const [who, got] of detail.byMerchant) {
      actualByMerchant.set(who, (actualByMerchant.get(who) ?? 0) + got);
    }
    return {
      accountId: a.id,
      name: a.name,
      spend: mine.reduce((n, l) => n + l.amount, 0),
      earned: detail.total,
      points: detail.points,
      caps: capRoom(r, detail.used, now),
      annualFee: r.annualFee ?? 0,
      base: r.base * r.pointCents,
      confirmedAt: r.confirmedAt,
      set: isSet(a),
      interest: interestOn(db, a.id, from, to),
      // Counted over the bonus's own window rather than the page's, because a
      // card opened eighteen months ago still has to say whether its bonus was
      // met, and a page showing the last year would only see part of it.
      bonus: r.bonus
        ? bonusProgress(r.bonus, spendOnCard(db, a.id, r.bonus.from, r.bonus.by), now)
        : undefined,
    };
  });

  // Only what was already on a card. The question this page answers is which
  // card to reach for, and that is only a question about money a card was
  // ever going to touch.
  const best = bestRouting(wallet, carded);

  const categories: CategoryLine[] = [...spent.entries()]
    .map(([categoryId, spend]) => {
      const got = actualByCategory.get(categoryId) ?? 0;
      const could = best.byCategory.get(categoryId);
      return {
        categoryId,
        spend,
        earned: got,
        best: could?.best ?? 0,
        gap: Math.max(0, (could?.best ?? 0) - got),
        bestAccountId: could ? leader(could.on) : undefined,
      };
    })
    .sort((a, b) => b.gap - a.gap || b.spend - a.spend);

  // The spelling the merchants page uses, so a row that links there does not
  // rename the shop on the way. Worked out from every transaction rather than
  // from this window's, because the most common spelling of a name is a fact
  // about the ledger and not about the last twelve months of it.
  const spellings = merchantIndex(db);
  const merchants: MerchantLine[] = [...spentAt.entries()]
    .map(([key, spend]) => {
      const got = actualByMerchant.get(key) ?? 0;
      const could = best.byMerchant.get(key);
      return {
        key,
        name: spellings.get(key)?.name ?? key,
        spend,
        earned: got,
        best: could?.best ?? 0,
        gap: Math.max(0, (could?.best ?? 0) - got),
        bestAccountId: could ? leader(could.on) : undefined,
        categoryId: leader(catAt.get(key) ?? new Map()),
      };
    })
    // Biggest spender first, unlike the categories, which lead with the
    // biggest miss. The question asked of a shop is "is there a card for this
    // place", and that is asked of the places the money actually goes,
    // whether or not the wallet is already handling them well. Missed is a
    // column and sorts on itself for anybody asking the other question.
    .sort((a, b) => b.spend - a.spend || b.gap - a.gap);

  const earnedTotal = cards.reduce((n, c) => n + c.earned, 0);
  const top = [...wallet].sort((a, b) =>
    b.rewards.base * b.rewards.pointCents - a.rewards.base * a.rewards.pointCents)[0];

  return {
    from, to, cards, categories, merchants,
    totals: {
      spend: carded.reduce((n, l) => n + l.amount, 0),
      earned: earnedTotal,
      best: best.total,
      gap: Math.max(0, best.total - earnedTotal),
    },
    driver: top ? {
      accountId: top.id,
      name: accounts.find((a) => a.id === top.id)?.name ?? "",
      rate: top.rewards.base * top.rewards.pointCents,
    } : undefined,
    offCard: {
      spend: elsewhere.reduce((n, l) => n + l.amount, 0),
      could: bestRouting(wallet, elsewhere).total,
    },
  };
}

/* ── the fee, the interest, and the bonus ──────────────────────────────── */

/**
 * Interest this card charged, which is the counterweight to everything above.
 *
 * Narrow on purpose: a charge on the card whose merchant or category says
 * interest or finance charge. Only stated when there is evidence, because a
 * page that guessed at interest would be worse than one that said nothing.
 * A card earning two percent while charging twenty-two is a losing card, and a
 * rewards page that never mentions that is lying by omission.
 */
const LOOKS_LIKE_INTEREST = /interest|finance charge/i;

export function interestOn(db: DB, accountId: ID, from: ISODate, to: ISODate): number {
  const name = new Map(db.categories.map((c) => [c.id, c.name]));
  let out = 0;
  for (const t of db.transactions) {
    if (t.accountId !== accountId || t.date < from || t.date > to || t.amount >= 0) continue;
    const said = `${t.merchant} ${name.get(t.categoryId) ?? ""}`;
    if (LOOKS_LIKE_INTEREST.test(said)) out += -t.amount;
  }
  return out;
}

export interface BonusProgress {
  requirement: number;
  spent: number;
  /** Never negative: what is still to spend. */
  left: number;
  /** Days from `now` to the last day that counts. Negative once it has gone. */
  daysLeft: number;
  met: boolean;
  /** The window has closed without the requirement being met. */
  missed: boolean;
  reward?: string;
}

/**
 * How far along a sign-up bonus is, counted from what the card was actually
 * charged inside its own window.
 */
export function bonusProgress(
  bonus: SignupBonus, spend: readonly SpendLine[], now: ISODate,
): BonusProgress {
  const spent = spend
    .filter((l) => l.date >= bonus.from && l.date <= bonus.by)
    .reduce((n, l) => n + l.amount, 0);
  const met = spent >= bonus.requirement;
  const daysLeft = Math.round(
    (parseISO(bonus.by).getTime() - parseISO(now).getTime()) / 86_400_000,
  );
  return {
    requirement: bonus.requirement,
    spent,
    left: Math.max(0, bonus.requirement - spent),
    daysLeft,
    met,
    missed: !met && daysLeft < 0,
    reward: bonus.reward,
  };
}

export interface Verdict {
  /** What the wallet earns as it stands. */
  without: number;
  /** What it would earn with this card in it. */
  withIt: number;
  /**
   * Never negative: a card can only ever be reached for when it wins, so the
   * walk should not be able to come out behind. The floor is belt and braces
   * against a future rule shape that could, not a case seen today.
   */
  gain: number;
  fee: number;
  /** The gain less the fee. Negative when the fee is not worth paying. */
  net: number;
  /** Spend the routing would move onto it. */
  onIt: number;
}

/**
 * What one more card would have been worth, on the year that happened.
 *
 * The same purchase-by-purchase walk, run twice: once over the wallet as it
 * is, once with the candidate in it. The difference is what the card would
 * have added, and the fee comes off it. It cannot come out negative before the
 * fee, because a card nobody has to reach for is simply never reached for.
 *
 * Only spending that already goes on a card. A new card cannot collect the
 * mortgage either, and counting money it could never touch is how a card pays
 * for itself on paper and not in the bank.
 */
export function candidateValue(
  db: DB, from: ISODate, to: ISODate, candidate: CardRewards,
): Verdict {
  const wallet = cardAccounts(db).map((a) => ({ id: a.id, rewards: rewardsOf(a) }));
  const spend = cardedSpend(db, from, to);

  const without = bestRouting(wallet, spend).total;
  const CANDIDATE = "__candidate__";
  const withCard = bestRouting([...wallet, { id: CANDIDATE, rewards: candidate }], spend);
  const gain = Math.max(0, withCard.total - without);
  const fee = candidate.annualFee ?? 0;
  return {
    without,
    withIt: withCard.total,
    gain,
    fee,
    net: gain - fee,
    onIt: withCard.byCard.get(CANDIDATE) ?? 0,
  };
}

/* ── what is sitting in the programs, and what to do about it ──────────── */

/**
 * A cap, and how much of it is still open in the bucket we are standing in.
 *
 * The one piece of this page with a deadline on it. A quarterly five percent
 * that still has four hundred dollars of room in it on the first of the month
 * is a thing to go and do; the same cap on the twenty-ninth is a thing to have
 * missed. So the room is counted in the bucket holding today, not across the
 * window, and the day it closes comes with it.
 */
export interface CapRoom {
  ruleId: ID;
  /** What the card calls it, when the rule was given a name. */
  label: string;
  rate: number;
  period?: "month" | "quarter" | "year";
  /** The limit, in cents of spending. */
  cap: number;
  /** Spent against it so far in this bucket, never more than the cap. */
  used: number;
  left: number;
  /** The last day this bucket counts, when it is one that resets. */
  until?: ISODate;
  /** What the room left is worth if it is used at this rate rather than base. */
  worth: number;
}

/** The last day of the bucket a cap is counting in. */
function capUntil(period: EarnRule["period"], now: ISODate): ISODate | undefined {
  if (!period) return undefined;
  if (period === "month") return monthEnd(monthOf(now));
  if (period === "year") return `${now.slice(0, 4)}-12-31`;
  const q = Math.floor((Number(now.slice(5, 7)) - 1) / 3);
  return monthEnd(`${now.slice(0, 4)}-${String(q * 3 + 3).padStart(2, "0")}`);
}

/**
 * The capped rules on a card, with the room left in each.
 *
 * Reads the usage map `earnDetail` hands back, so the answer is against the
 * same walk that produced the earnings rather than a second one that might
 * disagree with it. A cap with no period never resets, which makes the room
 * in it only as true as the window: it is shown, because a cap nobody has
 * touched in a year is worth knowing about either way.
 */
export function capRoom(rewards: CardRewards, used: Map<string, number>, now: ISODate): CapRoom[] {
  const out: CapRoom[] = [];
  for (const rule of rewards.rules) {
    if (rule.cap === undefined) continue;
    const spent = Math.min(rule.cap, used.get(`${rule.id}:${capKey(rule, now)}`) ?? 0);
    const left = Math.max(0, rule.cap - spent);
    out.push({
      ruleId: rule.id,
      label: rule.label ?? "",
      rate: rule.rate,
      period: rule.period,
      cap: rule.cap,
      used: spent,
      left,
      until: capUntil(rule.period, now),
      // Only the part of the rate the base rate does not already pay. The
      // room is worth the difference, not the whole bonus: that money was
      // going to earn something wherever it went.
      worth: Math.round((left / 100) * Math.max(0, rule.rate - rewards.base) * rewards.pointCents),
    });
  }
  return out.sort((a, b) => b.worth - a.worth || b.left - a.left);
}

/** A balance typed in this long ago is history rather than news. */
const BALANCE_STALE_DAYS = 90;

export interface RewardBalance {
  points: number;
  at: ISODate;
  /** The points in money, at the card's own valuation. */
  worth: number;
  stale: boolean;
}

export interface RewardCard {
  accountId: ID;
  name: string;
  /** Whether anybody has said what this card pays. Everything else is a guess until they do. */
  set: boolean;
  /**
   * Whether a person has read those terms off the card and said yes.
   *
   * Different from `set`, and the difference matters where the page passes
   * judgement: a draft Hopper filled in and nobody checked holds rates and a
   * fee, so it is "set", and convicting the card on arithmetic done against a
   * half-remembered rate is the one thing this page must not do.
   */
  confirmed: boolean;
  /** Earned in the window, in the card's own points. */
  points: number;
  /** The same earning in money, in cents. */
  value: number;
  /** What the card says one point is worth, in cents. */
  pointCents: number;
  spend: number;
  annualFee: number;
  interest: number;
  caps: CapRoom[];
  bonus?: BonusProgress;
  balance?: RewardBalance;
}

export type MoveKind =
  | "unset" | "bonus" | "cap" | "merchant" | "category" | "fee" | "offcard" | "stale";

/**
 * One thing that could be done, and what it is worth.
 *
 * Worth is over the window the report covers, which is a year, and is zero
 * where the gain cannot honestly be put in money - a bonus whose reward is a
 * phrase rather than a number, spending that may not be chargeable at all, a
 * card whose terms nobody has entered.
 */
export interface Move {
  kind: MoveKind;
  worth: number;
  title: string;
  detail: string;
  accountId?: ID;
  /** The key the merchants page groups this shop under. */
  merchant?: string;
  categoryId?: ID;
}

export interface RewardsSummary {
  from: ISODate;
  to: ISODate;
  /** Earned across every card in the window, in cents. */
  value: number;
  /** What the same spending would have earned on the best card held each time. */
  best: number;
  gap: number;
  spend: number;
  cards: RewardCard[];
  /**
   * The balances sitting with the issuers, added up in money.
   *
   * In money and not in points, because points do not add. A hundred thousand
   * of one program and a hundred thousand of another are not two hundred
   * thousand of anything, and the only thing the two have in common is what
   * the household thinks each is worth.
   */
  banked: { worth: number; cards: number; stale: boolean };
  moves: Move[];
  /** How many cards are still on the default rate because nobody has said otherwise. */
  unset: number;
}

/** A year's gain smaller than this is not worth asking somebody to change a habit over. */
const MOVE_FLOOR = 100;

/**
 * Everything the rewards tab shows.
 *
 * Handed the report rather than building one, because the page it serves
 * already has one: the cards tab and the rewards tab are two readings of the
 * same arithmetic, and a second walk would be both a second set of caps
 * filling up and a second place for the two tabs to disagree. What this adds
 * is the points themselves, the room left in the caps, the balances nothing
 * can fetch, and the list of things to actually do - which is the report's own
 * misrouting, read out in order of how much it costs.
 *
 * `now` wants to be the day the report was built against, or a cap will say
 * how full it is on one day and when it resets on another.
 */
export function rewardsSummary(
  db: DB, report: CardReport, now: ISODate = today(),
): RewardsSummary {
  const accounts = cardAccounts(db);
  const nameOf = (id?: ID): string =>
    (id ? accounts.find((a) => a.id === id)?.name ?? "" : "");
  const termsOf = new Map(accounts.map((a) => [a.id, rewardsOf(a)]));
  const categoryName = new Map(db.categories.map((c) => [c.id, c.name]));

  // Off the report rather than walked again. Everything here was already
  // computed to produce the cards tab, and a second walk would be a second
  // set of caps filling up.
  const cards: RewardCard[] = report.cards.map((line) => {
    const r = termsOf.get(line.accountId) ?? DEFAULT_REWARDS;
    const bal = r.balance;
    return {
      accountId: line.accountId,
      name: line.name,
      set: line.set,
      confirmed: !!line.confirmedAt,
      points: line.points,
      value: line.earned,
      pointCents: r.pointCents,
      spend: line.spend,
      annualFee: line.annualFee,
      interest: line.interest,
      caps: line.caps,
      bonus: line.bonus,
      balance: bal ? {
        points: bal.points,
        at: bal.at,
        worth: Math.round(bal.points * r.pointCents),
        stale: bal.at < addDays(now, -BALANCE_STALE_DAYS),
      } : undefined,
    };
  });

  const banked = cards.map((c) => c.balance).filter((b): b is RewardBalance => !!b);
  const moves: Move[] = [];

  // First, because nothing below it is true of a card whose terms are a
  // placeholder. A card on the default rate earns one percent on everything in
  // every figure on this page, whatever it actually pays.
  const unset = cards.filter((c) => !c.set);
  if (unset.length) {
    moves.push({
      kind: "unset",
      worth: 0,
      title: unset.length === 1
        ? `Say what ${unset[0]!.name} pays`
        : `Say what ${unset.length} cards pay`,
      detail: `${unset.map((c) => c.name).join(", ")} ${unset.length === 1 ? "is" : "are"} still counted at one percent on everything, which is a placeholder and not ${unset.length === 1 ? "its" : "their"} terms. Every number here moves once the real rates are in.`,
      accountId: unset.length === 1 ? unset[0]!.accountId : undefined,
    });
  }

  // Then the bonuses, because they are the only thing here that expires. A
  // deadline outranks a bigger number with no date on it.
  for (const c of cards) {
    const b = c.bonus;
    if (!b || b.met || b.missed) continue;
    moves.push({
      kind: "bonus",
      worth: 0,
      title: `${fmt(b.left, { cents: false })} to go on ${c.name}`,
      detail: `${b.reward ? `${b.reward}. ` : ""}${fmt(b.spent, { cents: false })} of ${fmt(b.requirement, { cents: false })} spent, and ${b.daysLeft} ${b.daysLeft === 1 ? "day" : "days"} left to spend the rest.`,
      accountId: c.accountId,
    });
  }

  for (const c of cards) {
    for (const cap of c.caps) {
      if (cap.worth < MOVE_FLOOR) continue;
      const what = cap.label || `${cap.rate}x`;
      moves.push({
        kind: "cap",
        worth: cap.worth,
        title: `${fmt(cap.left, { cents: false })} left at ${cap.rate}x on ${c.name}`,
        detail: `${what} is capped at ${fmt(cap.cap, { cents: false })}${cap.period ? ` a ${cap.period}` : ""} and ${fmt(cap.used, { cents: false })} of it has gone${cap.until ? `. The rest expires ${dateLabel(cap.until)}` : ""}.`,
        accountId: c.accountId,
      });
    }
  }

  // The misrouting, read straight off the report. Shops first and categories
  // after, because a shop is a decision somebody can make at a till and a
  // category is a habit, and the two overlap: a category whose whole miss is
  // one shop is already covered by the shop's own line.
  const saidFor = new Map<ID, number>();
  for (const m of report.merchants) {
    if (m.gap < MOVE_FLOOR || !m.bestAccountId) continue;
    moves.push({
      kind: "merchant",
      worth: m.gap,
      title: `Put ${m.name} on ${nameOf(m.bestAccountId)}`,
      detail: `${fmt(m.spend, { cents: false })} went there over the year and earned ${fmt(m.earned)}. On ${nameOf(m.bestAccountId)} it would have been ${fmt(m.best)}.`,
      accountId: m.bestAccountId,
      merchant: m.key,
    });
    // What this shop's line already accounts for, against the category it
    // mostly sits in.
    if (m.categoryId) saidFor.set(m.categoryId, (saidFor.get(m.categoryId) ?? 0) + m.gap);
  }
  for (const c of report.categories) {
    // Most of the way covered by shops already named is covered. Saying it
    // again as a category is the same money twice, in a list whose whole job
    // is to be read top down and acted on.
    if (c.gap < MOVE_FLOOR || !c.bestAccountId) continue;
    if ((saidFor.get(c.categoryId) ?? 0) >= c.gap * 0.6) continue;
    moves.push({
      kind: "category",
      worth: c.gap,
      title: `Put ${categoryName.get(c.categoryId) ?? "this spending"} on ${nameOf(c.bestAccountId)}`,
      detail: `${fmt(c.spend, { cents: false })} of it over the year, earning ${fmt(c.earned)} where it went and ${fmt(c.best)} where it should have.`,
      accountId: c.bestAccountId,
      categoryId: c.categoryId,
    });
  }

  // A fee is the one line here that is money going the other way.
  for (const c of cards) {
    if (!c.confirmed || c.annualFee <= 0 || c.annualFee <= c.value) continue;
    moves.push({
      kind: "fee",
      worth: c.annualFee - c.value,
      title: `${c.name} costs more than it earns`,
      detail: `The fee is ${fmt(c.annualFee)} a year and the card earned ${fmt(c.value)}. Worth checking whether the perks cover the difference, or whether there is a no-fee version of it.`,
      accountId: c.accountId,
    });
  }

  for (const b of banked) {
    if (!b.stale) continue;
    const card = cards.find((c) => c.balance === b)!;
    moves.push({
      kind: "stale",
      worth: 0,
      title: `Check the balance on ${card.name}`,
      detail: `${b.points.toLocaleString()} points was last typed in on ${dateLabel(b.at, { year: true })}, so it is probably not what is there now.`,
      accountId: card.accountId,
    });
  }

  // Last, and with no money on it on purpose. Most of what never touches a
  // card is rent, a mortgage or a tax bill that no card will take, so the
  // figure is in the sentence rather than in the ranking.
  if (report.offCard.could >= MOVE_FLOOR) {
    moves.push({
      kind: "offcard",
      worth: 0,
      title: "Some spending never touched a card",
      detail: `${fmt(report.offCard.spend, { cents: false })} went out another way. On a card it would have earned about ${fmt(report.offCard.could)}, though rent, a mortgage and a tax bill are usually in there and most of those cannot be charged.`,
    });
  }

  // Pinned first in the order they were pushed, then everything else by what
  // it is worth. A deadline and a wrong rate are not comparable to a number.
  const PINNED: MoveKind[] = ["unset", "bonus"];
  const pinned = moves.filter((m) => PINNED.includes(m.kind));
  const rest = moves.filter((m) => !PINNED.includes(m.kind)).sort((a, b) => b.worth - a.worth);

  return {
    from: report.from,
    to: report.to,
    value: report.totals.earned,
    best: report.totals.best,
    gap: report.totals.gap,
    spend: report.totals.spend,
    cards,
    banked: {
      worth: banked.reduce((n, b) => n + b.worth, 0),
      cards: banked.length,
      stale: banked.some((b) => b.stale),
    },
    moves: [...pinned, ...rest],
    unset: unset.length,
  };
}
