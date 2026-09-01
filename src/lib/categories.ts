import type { Category, CategoryGroup } from "../types.js";

/** [group name, kind, [category, emoji, color-var]] — the default taxonomy. */
const TAXONOMY: [string, "income" | "expense" | "transfer", [string, string, string][]][] = [
  ["Income", "income", [
    ["Paychecks", "\u{1F4B5}", "--c3"],
    ["Interest", "\u{1F4C8}", "--c3"],
    ["Business Income", "\u{1F4BC}", "--c3"],
    ["Other Income", "\u{2728}", "--c3"],
  ]],
  ["Housing", "expense", [
    ["Mortgage", "\u{1F3E1}", "--c2"],
    ["Rent", "\u{1F511}", "--c2"],
    ["Home Improvement", "\u{1F528}", "--c2"],
  ]],
  ["Bills & Utilities", "expense", [
    ["Gas & Electric", "\u{26A1}", "--c5"],
    ["Water", "\u{1F4A7}", "--c7"],
    ["Internet & Cable", "\u{1F4F6}", "--c2"],
    ["Phone", "\u{1F4F1}", "--c10"],
    ["Garbage", "\u{1F5D1}", "--c12"],
  ]],
  ["Auto & Transport", "expense", [
    ["Auto Payment", "\u{1F697}", "--c9"],
    ["Gas", "\u{26FD}", "--c9"],
    ["Auto Maintenance", "\u{1F527}", "--c9"],
    ["Parking & Tolls", "\u{1F17F}", "--c9"],
    ["Taxi & Ride Shares", "\u{1F695}", "--c9"],
    ["Public Transit", "\u{1F687}", "--c9"],
  ]],
  ["Food & Dining", "expense", [
    ["Groceries", "\u{1F6D2}", "--c1"],
    ["Restaurants & Bars", "\u{1F37D}", "--c1"],
    ["Coffee Shops", "\u{2615}", "--c1"],
  ]],
  ["Travel & Lifestyle", "expense", [
    ["Travel & Vacation", "\u{2708}", "--c4"],
    ["Entertainment & Recreation", "\u{1F3AC}", "--c4"],
    ["Personal", "\u{1F9F4}", "--c4"],
    ["Pets", "\u{1F415}", "--c4"],
    ["Fun Money", "\u{1F389}", "--c4"],
  ]],
  ["Shopping", "expense", [
    ["Shopping", "\u{1F6CD}", "--c6"],
    ["Clothing", "\u{1F455}", "--c6"],
    ["Furniture & Housewares", "\u{1F6CB}", "--c6"],
    ["Electronics", "\u{1F5A5}", "--c6"],
  ]],
  ["Health & Wellness", "expense", [
    ["Medical", "\u{1FA7A}", "--c7"],
    ["Dentist", "\u{1F9B7}", "--c7"],
    ["Fitness", "\u{1F3CB}", "--c7"],
  ]],
  ["Children", "expense", [
    ["Child Care", "\u{1F9F8}", "--c11"],
    ["Child Activities", "\u{26BD}", "--c11"],
  ]],
  ["Financial", "expense", [
    ["Insurance", "\u{1F6E1}", "--c12"],
    ["Loan Repayment", "\u{1F4C9}", "--c12"],
    ["Financial Fees", "\u{1F3E6}", "--c12"],
    ["Taxes", "\u{1F9FE}", "--c12"],
    ["Cash & ATM", "\u{1F4B5}", "--c12"],
  ]],
  ["Gifts & Donations", "expense", [
    ["Charity", "\u{1F49D}", "--c8"],
    ["Gifts", "\u{1F381}", "--c8"],
  ]],
  ["Other", "expense", [
    ["Uncategorized", "\u{2753}", "--c12"],
    ["Miscellaneous", "\u{1F4CE}", "--c12"],
  ]],
  ["Transfers", "transfer", [
    ["Transfer", "\u{1F501}", "--c10"],
    ["Credit Card Payment", "\u{1F4B3}", "--c10"],
    ["Savings Transfer", "\u{1F3E6}", "--c10"],
    ["Balance Adjustment", "\u{2696}", "--c10"],
  ]],
];

/** Stable ids so seeds, rules and imports can reference categories by slug. */
export const slug = (s: string): string =>
  s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function defaultTaxonomy(): { groups: CategoryGroup[]; categories: Category[] } {
  const groups: CategoryGroup[] = [];
  const categories: Category[] = [];
  TAXONOMY.forEach(([groupName, kind, cats], gi) => {
    const gid = `g_${slug(groupName)}`;
    groups.push({ id: gid, name: groupName, kind, order: gi });
    cats.forEach(([name, icon, color], ci) => {
      categories.push({
        id: `c_${slug(name)}`,
        groupId: gid,
        name,
        icon,
        color,
        excludeFromBudget: kind === "transfer" || name === "Balance Adjustment",
        rollover: false,
        order: ci,
      });
    });
  });
  return { groups, categories };
}

export const UNCATEGORIZED = "c_uncategorized";
export const TRANSFER = "c_transfer";
export const CC_PAYMENT = "c_credit_card_payment";
