import type { Account } from "../../types.js";

/**
 * Matching a provider's complaints to the accounts they are about.
 *
 * SimpleFIN reports trouble as a list of sentences about the pull as a whole,
 * not as a field on the account that has it. The sentences do generally name
 * the institution: "Connection to Elements Financial needs attention",
 * "We are upgrading this connection at Elements Financial". So the name is
 * what there is to go on, and matching on it puts the message where a person
 * would look for it, which is the account whose balance stopped moving.
 *
 * Deliberately conservative. An error that names nobody stays where it was,
 * at the provider, and is shown against the whole connection as before. It is
 * better to say something general in the right place than something specific
 * in the wrong one.
 */

/** Longer than any word that could match a bank by accident. */
const MIN_NAME = 4;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Which of these errors is about this account, if any.
 *
 * The longest matching institution name wins, so "Elements Financial" beats a
 * hypothetical "Elements" when a document holds both.
 */
export function noteFor(account: Account, errors: readonly string[]): string | undefined {
  const name = norm(account.institution ?? "");
  if (name.length < MIN_NAME) return undefined;
  return errors.find((e) => norm(e).includes(name));
}

/**
 * The errors nobody's institution answered to.
 *
 * These stay at the provider level: a message that names no bank is about the
 * connection as a whole, and pinning it to an arbitrary account would be a
 * guess dressed up as a fact.
 */
export function unclaimed(accounts: readonly Account[], errors: readonly string[]): string[] {
  const names = accounts
    .map((a) => norm(a.institution ?? ""))
    .filter((n) => n.length >= MIN_NAME);
  return errors.filter((e) => !names.some((n) => norm(e).includes(n)));
}
