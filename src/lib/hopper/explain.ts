import type { DB, Transaction } from "../../types.js";
import { fmt } from "../money.js";
import { turn } from "./loop.js";

/**
 * "What on earth was PAY*CITY OF FISHERS?"
 *
 * A bank statement line is written for a settlement system, not for a person,
 * and the one thing a budgeting app cannot do from its own data is tell you
 * what an unfamiliar one was. So this asks the model — the same one Hopper
 * uses, through the same function, which is where the API key lives.
 *
 * Unlike Hopper, it gets no tools and no digest. The question is about a
 * string on a receipt, not about this household's money, and the less of that
 * leaves the browser the better: what goes up is one statement line and the
 * few figures printed beside it on the screen the question was asked from.
 */

/** How many explanations the document keeps before the oldest are dropped. */
export const EXPLAIN_CACHE = 200;

export const EXPLAIN_SYSTEM = `You explain unfamiliar card and bank statement lines to the person who
was charged.

A statement line is written for a payment network, so it arrives full of
processor prefixes, city codes, store numbers and truncated names. Your job is
to say what the charge most likely was, in the words the person would use.

How to answer:

- Open with one sentence naming the merchant or organisation, and where it is
  if the line says so.
- If the line is a payment processor or portal rather than a merchant (PAY*,
  SQ*, SP, TST*, PYPL, WPY*, IC* and the like), say so and explain that the
  name after it is who was actually paid.
- When the line names an organisation that could have charged for several
  different things, list the common possibilities as a short bulleted list
  rather than guessing at one.
- Close with what the recognisable parts of the line mean, if any are worth
  pointing out.

Rules:

- Be honest about uncertainty. "Most likely" and "commonly" are correct;
  inventing a specific product or date is not. If the line is genuinely
  unreadable, say that and say which parts you can and cannot make out.
- Never guess at what the person bought when the merchant sells many things.
- Do not give budgeting, tax or financial advice, do not suggest a category,
  and do not comment on whether the amount is reasonable.
- No preamble, no sign-off, no offer to help further. Around 120 words.
- Plain sentences and simple hyphen bullets. No headings.`;

/** Everything the model is told about one transaction. */
export interface ExplainFacts {
  statement: string;
  merchant: string;
  amount: string;
  date: string;
  account?: string;
}

/**
 * The cache key for a statement line.
 *
 * Normalised, because the interesting part repeats and the noise does not: the
 * same city payment portal charges a different amount every month and often
 * carries a different trailing reference, and asking again for each of those
 * would pay twice for one answer. Case, runs of whitespace and trailing digit
 * groups come off; the merchant text that makes the line recognisable stays.
 */
export function explainKey(statement: string): string {
  return statement
    .toUpperCase()
    .replace(/[#*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Trailing store, terminal and reference numbers, which vary per charge.
    .replace(/(\s+\d{3,})+$/, "")
    .trim();
}

/** What the screen already shows, gathered for the question. */
export function explainFacts(db: DB, txn: Transaction): ExplainFacts {
  const account = db.accounts.find((a) => a.id === txn.accountId);
  return {
    statement: txn.statement || txn.merchant,
    merchant: txn.merchant,
    amount: fmt(Math.abs(txn.amount)),
    date: txn.date,
    account: account ? `${account.type} account` : undefined,
  };
}

/**
 * The question, as the model sees it.
 *
 * The statement line is fenced rather than quoted inline: these lines contain
 * asterisks, quotes and the occasional word that reads as an instruction, and
 * a line of a receipt has no business being read as one.
 */
export function explainPrompt(f: ExplainFacts): string {
  const lines = [
    "Explain this statement line.",
    "",
    "<statement>",
    f.statement,
    "</statement>",
    "",
    `Charged: ${f.amount} on ${f.date}`,
  ];
  if (f.account) lines.push(`Paid from: ${f.account}`);
  if (f.merchant && f.merchant !== f.statement) lines.push(`Filed under the name: ${f.merchant}`);
  return lines.join("\n");
}

/** What the document has already been told about this line, if anything. */
export function cachedExplanation(db: DB, statement: string): string | null {
  return db.settings.explanations?.[explainKey(statement)]?.text ?? null;
}

/**
 * Keeps one explanation, and drops the oldest once there are too many.
 *
 * The document is uploaded whole on every save, so an unbounded map of prose
 * would quietly become the largest thing in it. Two hundred lines is more
 * distinct merchants than a household sees in a year of statements.
 */
export function rememberExplanation(
  db: DB,
  statement: string,
  text: string,
  now: string = new Date().toISOString(),
): DB {
  const key = explainKey(statement);
  const kept: Record<string, { text: string; at: string }> = {
    ...(db.settings.explanations ?? {}),
    [key]: { text, at: now },
  };

  const ids = Object.keys(kept);
  if (ids.length > EXPLAIN_CACHE) {
    const oldest = ids.sort((a, b) => (kept[a]!.at < kept[b]!.at ? -1 : 1));
    for (const id of oldest.slice(0, ids.length - EXPLAIN_CACHE)) delete kept[id];
  }

  return { ...db, settings: { ...db.settings, explanations: kept } };
}

/**
 * Asks what a statement line was.
 *
 * No tools and no history: one question, one answer. The instructions are
 * marked cacheable for the same reason Hopper's are, though they are short
 * enough that Anthropic's minimum prefix will usually decline to cache them —
 * the saving that actually matters here is `cachedExplanation`, since the same
 * merchant comes round every month and the answer does not change.
 */
export async function explainTransaction(
  facts: ExplainFacts,
  onText?: (chunk: string) => void,
): Promise<string> {
  let text = "";
  await turn(
    {
      system: [{ type: "text", text: EXPLAIN_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: explainPrompt(facts) }],
    },
    (chunk) => { text += chunk; onText?.(text); },
  );
  return text.trim();
}
