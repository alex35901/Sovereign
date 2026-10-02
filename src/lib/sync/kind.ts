import type { PlaidItemRef } from "../../types.js";

/**
 * What one connection carries.
 *
 * A Plaid item is one login, and one login at a bank that does both reaches
 * the current accounts and the brokerage behind the same sign-in. This used
 * to be a choice between them, which was wrong in the one way that is hard to
 * see: the connection kept working, the balances kept arriving, and whichever
 * half had not been asked for simply never came. A household with cheque
 * accounts and an IRA at the same bank had to choose which half of their money
 * the app could see, or spend a second of the ten connections the plan allows
 * on the same login twice.
 *
 * So a connection may carry both. The two helpers below are the only thing
 * that should ever ask: every place that used to test for "bank" was really
 * asking one of these two questions, and the two answers are no longer
 * opposites.
 */
export type ItemKind = PlaidItemRef["kind"];

/** Whether a statement is expected down this connection. */
export const carriesTransactions = (kind: ItemKind): boolean => kind !== "investment";

/** Whether positions are expected down it. */
export const carriesHoldings = (kind: ItemKind): boolean => kind !== "bank";

/** What Plaid is asked for when the connection is made. */
export function productsFor(kind: ItemKind): string[] {
  const out: string[] = [];
  if (carriesTransactions(kind)) out.push("transactions");
  if (carriesHoldings(kind)) out.push("investments");
  return out;
}

/**
 * The same connection, now carrying one more thing.
 *
 * Additive on purpose. Asking a bank connection for investments used to turn
 * it into an investments connection, which answered half the question and
 * broke the other half, and there is nothing about a Plaid item that requires
 * the exchange.
 */
export function withProduct(kind: ItemKind, product: "transactions" | "investments"): ItemKind {
  if (product === "transactions") return carriesTransactions(kind) ? kind : "both";
  return carriesHoldings(kind) ? kind : "both";
}

/** What a connection is called in a sentence. */
export const kindLabel = (kind: ItemKind): string =>
  kind === "both" ? "bank and investments" : kind === "investment" ? "investments" : "bank";

/** What is missing from it, if anything, for the offer to add it. */
export function missingFrom(kind: ItemKind): "transactions" | "investments" | null {
  if (!carriesTransactions(kind)) return "transactions";
  if (!carriesHoldings(kind)) return "investments";
  return null;
}
