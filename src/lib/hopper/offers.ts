import type { CardDeal } from "../../types.js";
import { turn } from "./loop.js";

/**
 * This month's sign-up offers, as Hopper remembers them.
 *
 * The one thing on the cards page that is not arithmetic on this household's
 * own year. Everything else there is worked out from what was actually bought;
 * this is the market, which the app has no view of and no feed for, so it is
 * asked for and labelled as what it is: a recollection with a date on it, not
 * a rate card. Nothing about the household is sent to get it. The question is
 * "what is on offer", which has no answer that depends on their money, so no
 * figure of theirs goes anywhere near it.
 *
 * What comes back is checked the way every other number arriving from outside
 * is checked. The ratio is never read from the answer: it is reward over
 * spend, it is arithmetic, and arithmetic is the app's job.
 */

const SYSTEM = `You fill in one list: credit card sign-up offers worth knowing about.

Answer with JSON and nothing else. No prose, no code fence, no explanation
outside the object.

{
  "deals": [
    {
      "card": string,    // the card's name, as its issuer writes it
      "spend": number,   // dollars that must be spent to earn the bonus
      "months": number,  // months allowed to spend it, 0 if you do not know
      "reward": number,  // dollars the bonus is worth
      "note": string     // one short phrase, e.g. "60,000 points at 1.5c each"
    }
  ],
  "note": string         // one sentence: how current this is, and how sure
}

Rules:
- Dollars, never points and never cents. A points bonus is converted to what
  it is worth and the conversion is said in that deal's note.
- Leave out anything paying less than $100.
- Leave out anything with no minimum spend. One of the two rankings is reward
  against spend, and there is nothing to rank without a spend.
- At most ten. The list is read two ways, by what a bonus pays per dollar of
  spend and by the size of the bonus itself, so include both the best value
  for the money and the biggest bonuses even where those take a large spend.
  Only cards you are reasonably confident are current.
- Do not invent a card, an amount or a deadline. If you are not confident of
  any, return an empty list and say so in the note.
- Say in the note when your knowledge of these ends, because somebody is about
  to go and check them.`;

// The shapes live in types.ts with the rest of the document.
export type { CardDeal, CardOffers } from "../../types.js";

/**
 * The floor under what counts.
 *
 * A twenty-dollar bonus on a fifty-dollar spend is a ratio of 0.4, which would
 * sit above every real offer on the list and mean nothing: the ranking is
 * meant to find the best of the offers worth having, and something this small
 * is not one of them.
 */
export const MIN_REWARD = 100_00;

/** How many of each ranking survive onto the card. */
export const KEEP = 5;

/**
 * The two questions a list of sign-up offers answers.
 *
 * Not the same question twice. "Which pays most for the money" finds the card
 * worth opening for an ordinary year of spending; "which bonus is biggest"
 * finds the one worth stretching for, and the biggest bonuses are usually the
 * ones with a spend that drags their ratio down. Ranked one way and cut to
 * five, the other answer is not reordered, it is gone.
 */
export type DealView = "ratio" | "reward";

/** Past these a figure is a misread rather than an offer. */
const MAX_SPEND = 100_000_00;
const MAX_REWARD = 10_000_00;

/** Reward against spend. Higher is better, and it is worked out, never read. */
export const ratioOf = (d: CardDeal): number => (d.spend > 0 ? d.reward / d.spend : 0);

const dollars = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

const text = (v: unknown, max: number): string =>
  String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Whatever came back, read as a list of offers or as nothing at all.
 *
 * Every field checked rather than trusted, and every rule the question asked
 * for enforced here as well: a model told to leave out the small ones will
 * sometimes include them anyway, and a floor that only exists in the prompt is
 * not a floor.
 */
export function readOffers(raw: string): { deals: CardDeal[]; note: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Hopper did not answer with a list.");
  let got: Record<string, unknown>;
  try {
    got = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("Hopper did not answer with a list.");
  }

  const seen = new Set<string>();
  const deals: CardDeal[] = [];
  for (const row of Array.isArray(got.deals) ? got.deals : []) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const card = text(r.card, 60);
    const spend = dollars(r.spend);
    const reward = dollars(r.reward);
    // A deal needs a name, something to spend and something to get. Without a
    // spend there is no ratio, which is the only ordering this list has.
    if (!card || spend === null || reward === null) continue;
    if (spend <= 0 || spend > MAX_SPEND) continue;
    if (reward < MIN_REWARD || reward > MAX_REWARD) continue;
    // The same card twice, usually once per variant, would take two of five
    // places and say the same thing in both.
    const key = card.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const months = dollars(r.months) === null ? null : Math.round(Number(r.months));
    deals.push({
      card,
      spend,
      reward,
      months: months !== null && months > 0 && months <= 36 ? months : undefined,
      note: text(r.note, 90) || undefined,
    });
  }

  return { deals: rank(deals), note: text(got.note, 300) };
}

/** Every deal in order for one of the two questions, ties broken by the other. */
export const order = (deals: readonly CardDeal[], view: DealView): CardDeal[] =>
  [...deals].sort(view === "ratio"
    ? (a, b) => ratioOf(b) - ratioOf(a) || b.reward - a.reward
    : (a, b) => b.reward - a.reward || ratioOf(b) - ratioOf(a));

/** The best few by one measure, which is what the card shows at a time. */
export const topBy = (deals: readonly CardDeal[], view: DealView): CardDeal[] =>
  order(deals, view).slice(0, KEEP);

/**
 * What is worth keeping: enough that either question has a real answer.
 *
 * The best five by ratio and the best five by reward, which overlap and
 * usually come to seven or eight rather than ten. Keeping only one ranking's
 * five was the bug this replaces: a fifteen hundred dollar bonus on a fifteen
 * thousand dollar spend never made the stored list, so sorting the column by
 * reward could only reorder the survivors of a ranking that had already
 * thrown it away.
 */
export function rank(deals: readonly CardDeal[]): CardDeal[] {
  const keep = new Map<string, CardDeal>();
  for (const d of [...topBy(deals, "ratio"), ...topBy(deals, "reward")]) {
    keep.set(d.card.toLowerCase(), d);
  }
  return order([...keep.values()], "ratio");
}

/** Ask for this month's list. Throws whatever the endpoint threw. */
export async function fetchOffers(): Promise<{ deals: CardDeal[]; note: string }> {
  const answer = await turn({
    system: [{ type: "text", text: SYSTEM }],
    messages: [{
      role: "user",
      content: "List the credit card sign-up offers worth knowing about at the moment.",
    }],
  }, () => {});
  return readOffers(answer.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
}
