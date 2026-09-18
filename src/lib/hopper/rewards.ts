import type { Category, EarnRule, ID } from "../../types.js";
import { uid } from "../id.js";
import { turn } from "./loop.js";

/**
 * A first draft of what a card pays, for a person to check.
 *
 * The model is asked because typing six rates off a statement is tedious, not
 * because it knows. It does not: a rate it half-remembers from a card's
 * marketing page is a guess, and a guess that quietly routed a year of
 * groceries to the wrong card would cost real money. So nothing here is
 * written to the document. What comes back fills in a form, every line of it
 * visible, and the reader's own press of "Save and confirm" is the only thing
 * that marks the terms as checked.
 *
 * What is sent is the card's name and the household's own category names,
 * which is what a bonus rate has to be mapped onto to mean anything. No
 * balances, no transactions, no totals.
 */

const SYSTEM = `You fill in one form: what a single credit card pays back.

Answer with JSON and nothing else. No prose, no code fence, no explanation
outside the object.

{
  "base": number,          // earned per dollar on everything else
  "pointCents": number,    // what one of its points is worth in cents; 1 for cash back
  "annualFee": number,     // dollars per year, 0 if none
  "rules": [
    {
      "rate": number,      // earned per dollar in these categories
      "categories": string[], // names, chosen ONLY from the list you are given
      "cap": number,       // dollars of spending the rate applies to, 0 for none
      "period": "month" | "quarter" | "year" | "",
      "label": string      // a short condition, e.g. "booked through the issuer"
    }
  ],
  "note": string           // one short sentence on anything you are unsure of
}

Rules:
- Only use category names from the list given. Drop a bonus you cannot map.
- Rates are per dollar as the card counts them: 3 for 3% cash back, 3 for 3x
  points. Do not convert one into the other.
- Caps matter. If a rate is capped, say so; if you do not know, leave cap 0.
- If you do not recognise the card, return base 1, pointCents 1, no rules, and
  say so in the note. Do not invent a card.
- Your answer is a draft a person is about to check against their own card. Say
  in the note what you are least sure of.`;

export interface DraftRule {
  rate: number;
  categories: string[];
  cap?: number;
  period?: EarnRule["period"];
  label?: string;
}

export interface RewardsDraft {
  base: number;
  pointCents: number;
  annualFee: number;
  rules: DraftRule[];
  note: string;
}

/** Rates outside this are a misread, not a card. */
const MAX_RATE = 20;
const MAX_FEE = 10_000;

const num = (v: unknown, fallback: number, max: number): number => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
};

const PERIODS = new Set(["month", "quarter", "year"]);

/**
 * Whatever came back, read as a draft or not at all.
 *
 * Every field is checked rather than trusted. This is the one place in the app
 * where a number arrives from outside and goes near a form, and a model that
 * answered with prose, or with a rate of 400, must produce an empty draft
 * rather than a form full of nonsense.
 */
export function readDraft(text: string, known: readonly string[]): RewardsDraft {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Hopper did not answer with a draft.");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("Hopper did not answer with a draft.");
  }

  const names = new Map(known.map((n) => [n.toLowerCase(), n]));
  const rules: DraftRule[] = Array.isArray(raw.rules)
    ? raw.rules.flatMap((r): DraftRule[] => {
      const row = (r ?? {}) as Record<string, unknown>;
      const categories = (Array.isArray(row.categories) ? row.categories : [])
        .map((c) => names.get(String(c).toLowerCase().trim()))
        .filter((c): c is string => !!c);
      // A rate with nothing to apply to is not a rate. Dropped rather than
      // shown, because an empty row in the form reads as something to fill in.
      if (!categories.length) return [];
      const period = String(row.period ?? "");
      const cap = num(row.cap, 0, 1_000_000);
      return [{
        rate: num(row.rate, 1, MAX_RATE),
        categories,
        cap: cap > 0 ? cap : undefined,
        period: cap > 0 && PERIODS.has(period) ? period as EarnRule["period"] : undefined,
        label: typeof row.label === "string" ? row.label.slice(0, 80) : undefined,
      }];
    })
    : [];

  return {
    base: num(raw.base, 1, MAX_RATE),
    pointCents: num(raw.pointCents, 1, 10),
    annualFee: num(raw.annualFee, 0, MAX_FEE),
    rules,
    note: typeof raw.note === "string" ? raw.note.slice(0, 300) : "",
  };
}

/** The draft as rules this document can hold, with names turned back into ids. */
export function toRules(draft: RewardsDraft, categories: readonly Category[]): EarnRule[] {
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  return draft.rules.flatMap((r): EarnRule[] => {
    const categoryIds = r.categories
      .map((n) => byName.get(n.toLowerCase()))
      .filter((id): id is ID => !!id);
    if (!categoryIds.length) return [];
    return [{
      id: uid("er"),
      rate: r.rate,
      categoryIds,
      cap: r.cap ? Math.round(r.cap * 100) : undefined,
      period: r.period,
      label: r.label,
    }];
  });
}

/** Ask for one card's terms. Throws whatever the endpoint threw. */
export async function draftRewards(card: string, categories: readonly Category[]): Promise<RewardsDraft> {
  const names = categories.filter((c) => !c.archived).map((c) => c.name);
  const answer = await turn({
    system: [{ type: "text", text: SYSTEM }],
    messages: [{
      role: "user",
      content: `Card: ${card}\n\nCategories to choose from:\n${names.join("\n")}`,
    }],
  }, () => {});
  const text = answer.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  return readDraft(text, names);
}
