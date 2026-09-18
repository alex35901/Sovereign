import type { Account, CardRewards, DB, EarnRule, ID, ISODate, SignupBonus } from "../types.js";
import { monthOf, parseISO, today } from "./date.js";
import { categoryKind, counts, lines, mutedAccountIds } from "./select.js";

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
const claiming = (r: CardRewards, categoryId: ID): EarnRule[] =>
  r.rules.filter((x) => x.categoryIds.includes(categoryId)).sort((a, b) => b.rate - a.rate);

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
  let points = 0;
  // rate is per dollar and amounts are cents, so the product is points per
  // cent; pointCents turns points into cents of value.
  const value = (p: number) => Math.round((p / 100) * rewards.pointCents);

  for (const line of [...spend].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    let left = line.amount;
    let here = 0;
    for (const rule of claiming(rewards, line.categoryId)) {
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
  }

  // Rounded once at the end for the total and once per category, so a table of
  // categories can be a cent or two off the headline. Rounding each purchase
  // instead would be off by more, and in the same direction every time.
  return {
    total: value(points),
    byCategory: new Map([...byCategory].map(([id, p]) => [id, value(p)])),
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

export interface CardReport {
  from: ISODate;
  to: ISODate;
  cards: CardLine[];
  categories: CategoryLine[];
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
    for (const rule of claiming(c.rewards, line.categoryId)) {
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
    byCard.set(pick.id, (byCard.get(pick.id) ?? 0) + line.amount);
  }
  return { total, byCategory, byCard };
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

  for (const t of db.transactions) {
    if (t.date < from || t.date > to || !counts(t, muted)) continue;
    for (const l of lines(t)) {
      // Only money going out, and only on something that is really a purchase.
      if (l.amount >= 0 || categoryKind(db, l.categoryId) === "transfer") continue;
      const line: SpendLine = { date: t.date, categoryId: l.categoryId, amount: -l.amount };
      if (onCard.has(t.accountId)) {
        carded.push(line);
        spent.set(l.categoryId, (spent.get(l.categoryId) ?? 0) + line.amount);
        const at = byCard.get(t.accountId) ?? [];
        at.push(line);
        byCard.set(t.accountId, at);
      } else {
        elsewhere.push(line);
      }
    }
  }
  return { carded, elsewhere, byCard, spent };
}

/** What went on a card in the window, for anything weighing one card against another. */
export const cardedSpend = (db: DB, from: ISODate, to: ISODate): SpendLine[] =>
  walkSpend(db, from, to).carded;

/** What went on one card, over a window of its own. */
export const spendOnCard = (db: DB, accountId: ID, from: ISODate, to: ISODate): SpendLine[] =>
  walkSpend(db, from, to).byCard.get(accountId) ?? [];

export function cardReport(db: DB, from: ISODate, to: ISODate): CardReport {
  const accounts = cardAccounts(db);
  const wallet = accounts.map((a) => ({ id: a.id, rewards: rewardsOf(a) }));
  const { carded, elsewhere, byCard, spent } = walkSpend(db, from, to);

  // What was actually earned, card by card, and per category so the table can
  // set the two side by side.
  const actualByCategory = new Map<ID, number>();
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
    return {
      accountId: a.id,
      name: a.name,
      spend: mine.reduce((n, l) => n + l.amount, 0),
      earned: detail.total,
      annualFee: r.annualFee ?? 0,
      base: r.base * r.pointCents,
      confirmedAt: r.confirmedAt,
      set: isSet(a),
      interest: interestOn(db, a.id, from, to),
      // Counted over the bonus's own window rather than the page's, because a
      // card opened eighteen months ago still has to say whether its bonus was
      // met, and a page showing the last year would only see part of it.
      bonus: r.bonus
        ? bonusProgress(r.bonus, spendOnCard(db, a.id, r.bonus.from, r.bonus.by), today())
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

  const earnedTotal = cards.reduce((n, c) => n + c.earned, 0);
  const top = [...wallet].sort((a, b) =>
    b.rewards.base * b.rewards.pointCents - a.rewards.base * a.rewards.pointCents)[0];

  return {
    from, to, cards, categories,
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
