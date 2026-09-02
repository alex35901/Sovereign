import type { Category, Rule, RuleCriteria } from "../types.js";

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

const RECATEGORIZE = /^(?:recategorize|re-categorize|categorize|set\s+category)\s+(?:to\s+)?(.+)$/i;
const RENAME = /^(?:rename\s+(?:merchant\s+)?to|set\s+merchant\s+(?:name\s+)?to)\s+(.+)$/i;

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

export function parseMonarchRules(text: string, categories: Category[]): ParseResult {
  const byKey = new Map<string, Category>();
  for (const c of categories) {
    const key = categoryKey(c.name);
    if (!byKey.has(key)) byKey.set(key, c);
  }

  const rules: ParsedRule[] = [];
  const problems: ImportProblem[] = [];
  const unknown = new Set<string>();

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
      problems.push({ line, raw, why: "No “If merchant …” criteria on this line." });
      continue;
    }

    const matcher = MATCHERS.map((m) => ({ m, hit: m.re.exec(criteria) })).find((x) => x.hit);
    if (!matcher?.hit) {
      problems.push({
        line, raw,
        why: `Not a merchant rule this understands: “${criteria}”. Only merchant name criteria come across.`,
      });
      continue;
    }
    const merchant = clean(matcher.hit[1]!);
    if (!merchant) {
      problems.push({ line, raw, why: "The criteria names no merchant to match." });
      continue;
    }

    const actions = cells.filter((c) => c !== criteria);
    const recat = actions.map((a) => RECATEGORIZE.exec(a)).find(Boolean);
    const rename = actions.map((a) => RENAME.exec(a)).find(Boolean);

    if (!recat) {
      problems.push({
        line, raw,
        why: actions.length
          ? `No “Recategorize to …” action: “${actions.join(" · ")}”.`
          : "No action on this line.",
      });
      continue;
    }

    const categoryName = clean(recat[1]!);
    const found = byKey.get(categoryKey(categoryName)) ?? null;
    if (!found) unknown.add(categoryName);

    rules.push({
      line, raw, merchant,
      match: matcher.m.mode,
      categoryName,
      categoryId: found?.id ?? null,
      ...(rename ? { renameMerchant: clean(rename[1]!) } : {}),
    });
  }

  return { rules, problems, unknownCategories: [...unknown].sort() };
}

/** A readable name, since Monarch's rules have none of their own. */
export const ruleName = (r: ParsedRule): string => {
  const verb = r.match === "exact" ? "is" : r.match === "starts" ? "starts with"
    : r.match === "ends" ? "ends with" : "contains";
  return `${verb === "is" ? "" : `${verb} `}${r.merchant}`.trim();
};

/**
 * Turns the parsed rules into real ones.
 *
 * Only those with a category that resolved: a rule pointing at nothing would
 * match transactions and then do nothing to them, which is worse than not
 * existing, because it looks like it works.
 */
export function toRules(parsed: ParsedRule[], startOrder: number, uid: () => string): Rule[] {
  return parsed
    .filter((p) => p.categoryId)
    .map((p, i) => ({
      id: uid(),
      name: ruleName(p),
      enabled: true,
      order: startOrder + i,
      criteria: { merchantContains: p.merchant, merchantMatch: p.match },
      actions: {
        categoryId: p.categoryId!,
        markReviewed: true,
        ...(p.renameMerchant ? { renameMerchant: p.renameMerchant } : {}),
      },
    }));
}

/** Rules already here that would match the same merchant the same way. */
export function duplicatesOf(parsed: ParsedRule[], existing: Rule[]): Set<number> {
  const seen = new Set(existing
    .filter((r) => r.criteria.merchantContains)
    .map((r) => `${(r.criteria.merchantMatch ?? "contains")}:${r.criteria.merchantContains!.toLowerCase().trim()}`));
  const out = new Set<number>();
  for (const p of parsed) {
    const key = `${p.match}:${p.merchant.toLowerCase().trim()}`;
    if (seen.has(key)) out.add(p.line);
    seen.add(key);
  }
  return out;
}
