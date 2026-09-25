import type { DB, MerchantMatch, Rule, RuleCriteria, Transaction } from "../types.js";

/** How each comparison reads, for a summary line and for the editor. */
export const MATCH_WORD: Record<MerchantMatch, string> = {
  contains: "contains", exact: "is exactly", starts: "starts with", ends: "ends with",
};

/** One merchant test, and how it joins to the one before it. */
export interface MerchantTest {
  text: string;
  match: MerchantMatch;
  /** Absent on the first, which has nothing to join to. */
  join?: "and" | "or";
}

/**
 * A rule's merchant conditions as one list, however they are stored.
 *
 * The first lives in its own two fields because every rule ever written has it
 * there, and the rest in a list beside them. Reading them as one list is what
 * the editor and the matcher both actually want, and it keeps the shape of a
 * stored rule out of both.
 *
 * Empty ones are dropped: a blank box in the editor is a condition somebody
 * has not written yet, not a condition that matches everything.
 */
export function merchantTests(c: RuleCriteria): MerchantTest[] {
  const out: MerchantTest[] = [];
  const first = (c.merchantContains ?? "").trim();
  if (first) out.push({ text: first, match: c.merchantMatch ?? "contains" });
  for (const also of c.merchantAlso ?? []) {
    if (also.text.trim()) out.push({ text: also.text.trim(), match: also.match, join: also.join });
  }
  return out;
}

/** Whether one test holds. */
function hits(t: Transaction, test: MerchantTest): boolean {
  const want = test.text.toLowerCase().trim();
  const merchant = t.merchant.toLowerCase().trim();
  // "contains" looks at the raw statement too, because that is where a
  // half-recognised merchant hides. The exact forms compare the merchant name
  // alone: an exact rule that quietly matched a substring of the statement
  // would not be exact at all.
  if (test.match === "exact") return merchant === want;
  if (test.match === "starts") return merchant.startsWith(want);
  if (test.match === "ends") return merchant.endsWith(want);
  return `${t.merchant} ${t.statement ?? ""}`.toLowerCase().includes(want);
}

/**
 * Every merchant test, folded left to right.
 *
 * No precedence: "and" does not bind tighter than "or" here. A rule is read
 * the way the editor draws it, one line after another, top to bottom, and a
 * household writing three conditions should get the answer the page appears to
 * describe rather than the one an operator table would give. Nothing here is
 * clever enough to need brackets, and a rule that would is better written as
 * two rules.
 */
export function merchantMatches(t: Transaction, tests: readonly MerchantTest[]): boolean {
  if (!tests.length) return true;
  let ok = hits(t, tests[0]!);
  for (let i = 1; i < tests.length; i++) {
    const test = tests[i]!;
    ok = test.join === "or" ? ok || hits(t, test) : ok && hits(t, test);
  }
  return ok;
}

export function ruleMatches(rule: Rule, t: Transaction): boolean {
  const c = rule.criteria;
  if (!rule.enabled) return false;
  if (!merchantMatches(t, merchantTests(c))) return false;
  if (c.accountId && t.accountId !== c.accountId) return false;
  if (c.direction === "in" && t.amount < 0) return false;
  if (c.direction === "out" && t.amount >= 0) return false;
  const abs = Math.abs(t.amount);
  if (c.amountMin !== undefined && abs < c.amountMin) return false;
  if (c.amountMax !== undefined && abs > c.amountMax) return false;
  return true;
}

/** Returns a new transaction with every matching rule's actions applied, in order. */
export function applyRules(rules: Rule[], t: Transaction): Transaction {
  let out = t;
  for (const rule of [...rules].sort((a, b) => a.order - b.order)) {
    if (!ruleMatches(rule, out)) continue;
    const a = rule.actions;
    out = {
      ...out,
      categoryId: a.categoryId ?? out.categoryId,
      merchant: a.renameMerchant ?? out.merchant,
      tags: a.addTags?.length ? [...new Set([...out.tags, ...a.addTags])] : out.tags,
      hideFromReports: a.hideFromReports ?? out.hideFromReports,
      reviewed: a.markReviewed ? true : out.reviewed,
    };
  }
  return out;
}

export function countMatches(db: DB, rule: Rule): number {
  return db.transactions.filter((t) => ruleMatches(rule, t)).length;
}
