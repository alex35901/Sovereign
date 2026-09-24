/**
 * Anything with a bank's name on it.
 *
 * Accounts, and also the connections themselves. A connection linked a minute
 * ago has an error and no accounts yet, so matching only against accounts said
 * its message named nobody, which meant showing it against everybody.
 */
export interface Named { institution?: string }

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
export function noteFor(account: Named, errors: readonly string[]): string | undefined {
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
export function unclaimed(known: readonly Named[], errors: readonly string[]): string[] {
  const names = known
    .map((a) => norm(a.institution ?? ""))
    .filter((n) => n.length >= MIN_NAME);
  return errors.filter((e) => !names.some((n) => norm(e).includes(n)));
}

/** The most words a bank's name can take before a prefix stops being one. */
const PREFIX_WORDS = 4;

/**
 * The bank a message is addressed to, when it wears one as a prefix.
 *
 * The Plaid path writes its errors as "Valon Mortgage: ...", so the name is
 * there in the message whether or not this document has heard of that bank
 * yet. And the message that matters most here is precisely the one about a
 * connection with no accounts in it: "Plaid is still preparing this
 * connection's transactions" is by definition about a bank nothing has arrived
 * from, so a rule that only recognises banks it already knows decides that one
 * names nobody, and a message that names nobody gets shown to everybody.
 *
 * Conservative about what counts as a prefix. A few words with no sentence
 * punctuation in them is a name; "Plaid isn't configured on the server: add
 * PLAID_CLIENT_ID" is a sentence that happens to contain a colon, and it is
 * about the whole connection.
 */
export function addressedTo(error: string): string | undefined {
  const at = error.indexOf(":");
  if (at < MIN_NAME) return undefined;
  const head = error.slice(0, at).trim();
  if (/[.!?,;]/.test(head)) return undefined;
  if (head.split(/\s+/).length > PREFIX_WORDS) return undefined;
  return head;
}

/**
 * Whether this message is about one bank rather than the connection as a
 * whole. Either it names one this document knows, or it is addressed to one.
 */
export function namesABank(known: readonly Named[], error: string): boolean {
  return Boolean(addressedTo(error)) || unclaimed(known, [error]).length === 0;
}
