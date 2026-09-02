import type { Category, Rule, RuleCriteria, Tag } from "../types.js";
import { parseMoney } from "./money.js";

/**
 * Reading Monarch's exported rules.
 *
 * Their export is a line per rule: a sentence describing the criteria, a
 * sentence describing what it does, and usually a trailing empty column.
 *
 *   If merchant name exactly matches fair oaks farms	Recategorize to 🍽 Restaurants & Bars
 *
 * The sentences are prose, not a format with a specification, so this is
 * deliberately built to *report* rather than to guess. Anything it does not
 * recognise comes back as a problem naming the line, and nothing is created
 * until someone has looked at the list. Silently dropping 6 of 118 rules and
 * saying "imported!" is the failure worth designing against — you would not
 * find out until a transaction landed in the wrong category months later.
 */

/** How the criteria sentence names each way of comparing a merchant. */
const MATCHERS: { re: RegExp; mode: NonNullable<RuleCriteria["merchantMatch"]> }[] = [
  { re: /^if\s+merchant\s+(?:name\s+)?exactly\s+matches\s+(.+)$/i, mode: "exact" },
  { re: /^if\s+merchant\s+(?:name\s+)?is\s+exactly\s+(.+)$/i, mode: "exact" },
  { re: /^if\s+merchant\s+(?:name\s+)?contains\s+(.+)$/i, mode: "contains" },
  { re: /^if\s+merchant\s+(?:name\s+)?starts\s+with\s+(.+)$/i, mode: "starts" },
  { re: /^if\s+merchant\s+(?:name\s+)?ends\s+with\s+(.+)$/i, mode: "ends" },
  // the bare form, which Monarch uses when the match type is its default
  { re: /^if\s+merchant\s+(?:name\s+)?matches\s+(.+)$/i, mode: "contains" },
];

/**
 * Amount clauses. Monarch's export runs the words together — "creditequals
 * $350.00" — so the spaces are optional throughout.
 *
 * "credit" is money in and "debit" money out; "amount" says nothing about
 * direction. An exact figure is stored as a range with both ends the same,
 * which is what the rule engine already understands.
 */
const AMOUNTS: { re: RegExp; of: (a: number, b: number) => Partial<RuleCriteria> }[] = [
  {
    re: /^(credit|debit|amount|income|expense)\s*(?:is\s*)?between\s*\$?([\d,.]+)\s*(?:and|to|-)\s*\$?([\d,.]+)$/i,
    of: (a, b) => ({ amountMin: Math.min(a, b), amountMax: Math.max(a, b) }),
  },
  {
    re: /^(credit|debit|amount|income|expense)\s*(?:is\s*)?(?:equals?|is\s*exactly|=)\s*\$?([\d,.]+)$/i,
    of: (a) => ({ amountMin: a, amountMax: a }),
  },
  {
    re: /^(credit|debit|amount|income|expense)\s*(?:is\s*)?(?:greater\s*than|more\s*than|over|above|>)\s*\$?([\d,.]+)$/i,
    of: (a) => ({ amountMin: a }),
  },
  {
    re: /^(credit|debit|amount|income|expense)\s*(?:is\s*)?(?:less\s*than|under|below|<)\s*\$?([\d,.]+)$/i,
    of: (a) => ({ amountMax: a }),
  },
];

const DIRECTION: Record<string, "in" | "out" | undefined> = {
  credit: "in", income: "in", debit: "out", expense: "out", amount: undefined,
};

/**
 * Where one "If" clause ends and the next begins.
 *
 * Monarch concatenates them with no separator, so the split is on "If"
 * followed by a word that actually opens a clause. Splitting on every "If"
 * would cut a merchant called "WHAT IF COFFEE" in half.
 */
const NEXT_CLAUSE = /\s+If\s+(?=merchant|amount|credit|debit|income|expense|account|category)/i;

/** Actions are concatenated the same way. */
const NEXT_ACTION = /\s+(?=Add\s+tags?\b|Rename\s+merchant\b|Set\s+merchant\b|Hide\s+from\s+reports\b|Mark\s+as\s+reviewed\b|Review\b)/i;

const RECATEGORIZE = /^(?:recategorize|re-categorize|categorize|set\s+category)\s+(?:to\s+)?(.+)$/i;
const RENAME = /^(?:rename\s+(?:merchant\s+)?to|set\s+merchant\s+(?:name\s+)?to)\s+(.+)$/i;
const ADD_TAG = /^add\s+tags?\s+(.+)$/i;

/** Emoji, variation selectors and the space after them — Monarch prefixes names. */
const LEADING_ICON = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍\s]+/u;

/** Quotes and stray whitespace a spreadsheet round-trip leaves behind. */
export const clean = (s: string): string =>
  s.trim().replace(/^["'‘’“”]+|["'‘’“”]+$/g, "").trim();

/** "🍽 Restaurants & Bars" and "restaurants and bars" have to meet. */
export const categoryKey = (name: string): string =>
  name.replace(LEADING_ICON, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export interface ParsedRule {
  /** 1-based, so a problem can be pointed at in the pasted text. */
  line: number;
  raw: string;
  merchant: string;
  match: NonNullable<RuleCriteria["merchantMatch"]>;
  /** Money in, money out, or unstated. */
  direction?: "in" | "out";
  amountMin?: number;
  amountMax?: number;
  /** Tag names as written; the ones that do not exist yet are created. */
  tags: string[];
  /** The category as written in the export, icon and all. */
  categoryName: string;
  /** The category it resolved to here, or null when nothing matched. */
  categoryId: string | null;
  renameMerchant?: string;
}

export interface ImportProblem {
  line: number;
  raw: string;
  why: string;
}

export interface ParseResult {
  rules: ParsedRule[];
  problems: ImportProblem[];
  /** Category names in the export with nothing to map onto here. */
  unknownCategories: string[];
  /** Tag names not yet here. Unlike categories these are made on import. */
  newTags: string[];
}

/**
 * Splits a pasted export into fields.
 *
 * Tabs are what a spreadsheet copy gives, and what the example used. A line
 * with none is tried on two-or-more spaces, which is what a text export tends
 * to produce, and finally on a comma outside quotes.
 */
export function fields(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map(clean);
  if (/\s{2,}/.test(line)) return line.split(/\s{2,}/).map(clean);
  const parts = line.match(/(?:"[^"]*"|'[^']*'|[^,])+/g);
  return (parts ?? [line]).map(clean);
}

export function parseMonarchRules(text: string, categories: Category[], existingTags: Tag[] = []): ParseResult {
  const byKey = new Map<string, Category>();
  for (const c of categories) {
    const key = categoryKey(c.name);
    if (!byKey.has(key)) byKey.set(key, c);
  }

  const tagKeys = new Set(existingTags.map((t) => t.name.toLowerCase()));

  const rules: ParsedRule[] = [];
  const problems: ImportProblem[] = [];
  const unknown = new Set<string>();
  const fresh = new Set<string>();

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = i + 1;
    if (!raw.trim()) continue;

    const cells = fields(raw).filter((c) => c.length > 0);
    if (!cells.length) continue;

    // A header row from a spreadsheet copy, rather than a rule. Deliberately
    // narrow: anything starting with "If" is a rule, including the kinds this
    // cannot translate, and those have to be reported rather than skipped.
    if (/^(criteria|conditions?|rules?|when|then|actions?)$/i.test(cells[0]!)) continue;

    const criteria = cells.find((c) => /^if\b/i.test(c));
    if (!criteria) {
      problems.push({ line, raw, why: "No \u201cIf merchant \u2026\u201d criteria on this line." });
      continue;
    }

    // One line can carry several clauses run together, and every one of them
    // has to be understood: a rule imported with half its criteria would match
    // far more than it was ever meant to.
    const clauses = criteria.split(NEXT_CLAUSE).map((c) => clean(c.replace(/^if\s+/i, "")));
    let merchant = "";
    let match: NonNullable<RuleCriteria["merchantMatch"]> = "contains";
    let amount: Partial<RuleCriteria> = {};
    let direction: "in" | "out" | undefined;
    let unreadable: string | null = null;

    for (const clause of clauses) {
      if (!clause) continue;
      const asMerchant = MATCHERS.map((m) => ({ m, hit: m.re.exec(`If ${clause}`) })).find((x) => x.hit);
      if (asMerchant?.hit) {
        merchant = clean(asMerchant.hit[1]!);
        match = asMerchant.m.mode;
        continue;
      }
      const asAmount = AMOUNTS.map((a) => ({ a, hit: a.re.exec(clause) })).find((x) => x.hit);
      if (asAmount?.hit) {
        const [, kind, one, two] = asAmount.hit;
        amount = { ...amount, ...asAmount.a.of(parseMoney(one!), parseMoney(two ?? one!)) };
        direction = DIRECTION[kind!.toLowerCase()] ?? direction;
        continue;
      }
      unreadable = clause;
      break;
    }

    if (unreadable) {
      problems.push({
        line, raw,
        why: `Not a criteria this understands: \u201c${unreadable}\u201d. Merchant name and amount come across; anything else does not.`,
      });
      continue;
    }
    if (!merchant && !Object.keys(amount).length) {
      problems.push({ line, raw, why: "The criteria names nothing to match on." });
      continue;
    }

    // Actions run together the same way, and a dropped "Add tag" would be a
    // rule that looks right and quietly does less than it says.
    const actions = cells
      .filter((c) => c !== criteria && !/^\d+$/.test(c))
      .flatMap((c) => c.split(NEXT_ACTION).map(clean))
      .filter(Boolean);

    const recat = actions.map((a) => RECATEGORIZE.exec(a)).find(Boolean);
    const rename = actions.map((a) => RENAME.exec(a)).find(Boolean);
    const tags = actions
      .map((a) => ADD_TAG.exec(a))
      .filter(Boolean)
      .map((m) => clean(m![1]!))
      .filter(Boolean);

    if (!recat) {
      problems.push({
        line, raw,
        why: actions.length
          ? `No \u201cRecategorize to \u2026\u201d action: \u201c${actions.join(" \u00b7 ")}\u201d.`
          : "No action on this line.",
      });
      continue;
    }

    const categoryName = clean(recat[1]!);
    const found = byKey.get(categoryKey(categoryName)) ?? null;
    if (!found) unknown.add(categoryName);
    for (const t of tags) {
      if (!tagKeys.has(t.toLowerCase())) fresh.add(t);
    }

    rules.push({
      line, raw, merchant, match, categoryName, tags,
      categoryId: found?.id ?? null,
      ...(direction ? { direction } : {}),
      ...amount,
      ...(rename ? { renameMerchant: clean(rename[1]!) } : {}),
    });
  }

  return {
    rules, problems,
    unknownCategories: [...unknown].sort(),
    newTags: [...fresh].sort(),
  };
}

/** A readable name, since Monarch's rules have none of their own. */
export const ruleName = (r: ParsedRule): string => {
  const verb = r.match === "exact" ? "" : r.match === "starts" ? "starts with "
    : r.match === "ends" ? "ends with " : "contains ";
  const money = (n: number): string => `$${(n / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const amount = r.amountMin !== undefined && r.amountMin === r.amountMax ? money(r.amountMin)
    : r.amountMin !== undefined && r.amountMax !== undefined ? `${money(r.amountMin)}–${money(r.amountMax)}`
    : r.amountMin !== undefined ? `over ${money(r.amountMin)}`
    : r.amountMax !== undefined ? `under ${money(r.amountMax)}`
    : "";
  const way = r.direction === "in" ? "in" : r.direction === "out" ? "out" : "";
  const tail = [amount, way].filter(Boolean).join(" ");
  return [`${verb}${r.merchant}`.trim(), tail].filter(Boolean).join(" · ") || "imported rule";
};

/**
 * Turns the parsed rules into real ones.
 *
 * Only those with a category that resolved: a rule pointing at nothing would
 * match transactions and then do nothing to them, which is worse than not
 * existing, because it looks like it works.
 */
export function toRules(
  parsed: ParsedRule[],
  startOrder: number,
  uid: () => string,
  /** Lowercased tag name to id, for the tags an imported rule adds. */
  tagIds: Map<string, string> = new Map(),
): Rule[] {
  return parsed
    .filter((p) => p.categoryId)
    .map((p, i) => {
      const addTags = p.tags
        .map((t) => tagIds.get(t.toLowerCase()))
        .filter((id): id is string => !!id);
      return {
        id: uid(),
        name: ruleName(p),
        enabled: true,
        order: startOrder + i,
        criteria: {
          ...(p.merchant ? { merchantContains: p.merchant, merchantMatch: p.match } : {}),
          ...(p.direction ? { direction: p.direction } : {}),
          ...(p.amountMin !== undefined ? { amountMin: p.amountMin } : {}),
          ...(p.amountMax !== undefined ? { amountMax: p.amountMax } : {}),
        },
        actions: {
          categoryId: p.categoryId!,
          markReviewed: true,
          ...(addTags.length ? { addTags } : {}),
          ...(p.renameMerchant ? { renameMerchant: p.renameMerchant } : {}),
        },
      };
    });
}

/** Rules already here that would match the same merchant the same way. */
export function duplicatesOf(parsed: ParsedRule[], existing: Rule[]): Set<number> {
  const key = (c: RuleCriteria): string => [
    c.merchantMatch ?? "contains",
    (c.merchantContains ?? "").toLowerCase().trim(),
    c.direction ?? "",
    c.amountMin ?? "",
    c.amountMax ?? "",
  ].join(":");
  const seen = new Set(existing.map((r) => key(r.criteria)));
  const out = new Set<number>();
  for (const p of parsed) {
    const k = key({
      merchantContains: p.merchant, merchantMatch: p.match,
      direction: p.direction, amountMin: p.amountMin, amountMax: p.amountMax,
    });
    if (seen.has(k)) out.add(p.line);
    seen.add(k);
  }
  return out;
}
