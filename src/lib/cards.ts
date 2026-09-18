import type { Account, CardRewards, DB, EarnRule, ID, ISODate } from "../types.js";
import { monthOf } from "./date.js";
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
  /** Spend that never touched a card, and so earned nothing at all. */
  offCard: number;
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
  let total = 0;

  const rateOn = (c: { id: ID; rewards: CardRewards }, line: SpendLine, amount: number) => {
    for (const rule of claiming(c.rewards, line.categoryId)) {
      if (rule.cap === undefined) return { value: amount * rule.rate * c.rewards.pointCents, rule };
      const key = `${c.id}:${rule.id}:${capKey(rule, line.date)}`;
      if ((used.get(key) ?? 0) >= rule.cap) continue;
      return { value: amount * rule.rate * c.rewards.pointCents, rule, key };
    }
    return { value: amount * c.rewards.base * c.rewards.pointCents, rule: undefined };
  };

  for (const line of [...spend].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    let pick = null as null | { id: ID; value: number; key?: string };
    for (const c of cards) {
      const { value, key } = rateOn(c, line, line.amount);
      if (!pick || value > pick.value) pick = { id: c.id, value, key };
    }
    if (!pick) continue;
    // Charged against the cap it was paid from, so the next purchase sees a
    // wallet in the state this one left it.
    if (pick.key) used.set(pick.key, (used.get(pick.key) ?? 0) + line.amount);
    const value = Math.round(pick.value / 100);
    total += value;
    const at = byCategory.get(line.categoryId) ?? { best: 0, on: new Map<ID, number>() };
    at.best += value;
    at.on.set(pick.id, (at.on.get(pick.id) ?? 0) + line.amount);
    byCategory.set(line.categoryId, at);
  }
  return { total, byCategory };
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
export function cardReport(db: DB, from: ISODate, to: ISODate): CardReport {
  const accounts = cardAccounts(db);
  const wallet = accounts.map((a) => ({ id: a.id, rewards: rewardsOf(a) }));
  const onCard = new Set(accounts.map((a) => a.id));
  const muted = mutedAccountIds(db);

  const all: SpendLine[] = [];
  const byCard = new Map<ID, SpendLine[]>();
  const spent = new Map<ID, number>();
  let offCard = 0;

  for (const t of db.transactions) {
    if (t.date < from || t.date > to || !counts(t, muted)) continue;
    for (const l of lines(t)) {
      // Only money going out, and only on something that is really a purchase.
      if (l.amount >= 0 || categoryKind(db, l.categoryId) === "transfer") continue;
      const line: SpendLine = { date: t.date, categoryId: l.categoryId, amount: -l.amount };
      all.push(line);
      spent.set(l.categoryId, (spent.get(l.categoryId) ?? 0) + line.amount);
      if (onCard.has(t.accountId)) {
        const at = byCard.get(t.accountId) ?? [];
        at.push(line);
        byCard.set(t.accountId, at);
      } else {
        offCard += line.amount;
      }
    }
  }

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
    };
  });

  const best = bestRouting(wallet, all);

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
      spend: all.reduce((n, l) => n + l.amount, 0),
      earned: earnedTotal,
      best: best.total,
      gap: Math.max(0, best.total - earnedTotal),
    },
    driver: top ? {
      accountId: top.id,
      name: accounts.find((a) => a.id === top.id)?.name ?? "",
      rate: top.rewards.base * top.rewards.pointCents,
    } : undefined,
    offCard,
  };
}
