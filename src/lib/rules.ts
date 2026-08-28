import type { DB, Rule, Transaction } from "../types";

export function ruleMatches(rule: Rule, t: Transaction): boolean {
  const c = rule.criteria;
  if (!rule.enabled) return false;
  if (c.merchantContains) {
    const hay = `${t.merchant} ${t.statement ?? ""}`.toLowerCase();
    if (!hay.includes(c.merchantContains.toLowerCase())) return false;
  }
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
