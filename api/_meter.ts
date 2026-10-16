import { db, onDemandTable } from "./_store.js";

/**
 * What has actually been spent at a metered provider this month, counted on
 * the way out rather than in the document.
 *
 * The app already counts its own calls, in the household's document, so the
 * integrations table can say what a provider has cost. That count is honest
 * about what one browser did and cannot be honest about the total: every
 * device keeps its own copy of the document and the newest copy wins, so two
 * devices that each spend a lookup and each add one to the count can arrive at
 * a total of one. The provider, meanwhile, counted two, and the first anybody
 * hears about the difference is a warning email.
 *
 * So the ceiling that matters lives here, on the one path every request to the
 * provider actually takes. One row per provider per month, incremented inside
 * the statement that reads it, which is a count no race can lose.
 *
 * Nothing here knows what the household's plan allows: that is between them
 * and the provider. What it enforces is a ceiling this app will not spend
 * past, which is a different and more useful promise.
 */

const table = onDemandTable(`
  CREATE TABLE IF NOT EXISTS provider_spend (
    id text PRIMARY KEY,
    spent integer NOT NULL,
    at timestamptz NOT NULL
  )
`);

/** The month a spend belongs to, in the provider's own terms: a calendar one. */
export const monthKey = (now: number = Date.now()): string =>
  new Date(now).toISOString().slice(0, 7);

export interface Claim {
  /** Whether this request may go on to the provider. */
  allowed: boolean;
  /** What has been spent this month once this claim is counted. */
  spent: number;
  cap: number;
}

/**
 * Takes one request out of the month's allowance, or refuses.
 *
 * The increment and the check are one statement on purpose. Reading the count
 * and then writing it back is the same lost update this exists to prevent,
 * one layer down: two functions running at once would both read nine, both
 * write ten, and both go on to spend.
 *
 * A claim is spent whether or not the provider gives a useful answer, because
 * that is how the provider counts it too: an address it has no record of is a
 * request it has already served.
 */
export async function claimRequest(
  provider: string,
  cap: number,
  now: number = Date.now(),
): Promise<Claim> {
  const id = `${provider}:${monthKey(now)}`;
  const { rows } = await table.guard(async () => (await db()).query(
    `INSERT INTO provider_spend (id, spent, at) VALUES ($1, 1, to_timestamp($3 / 1000.0))
     ON CONFLICT (id) DO UPDATE SET spent = provider_spend.spent + 1, at = to_timestamp($3 / 1000.0)
     WHERE provider_spend.spent < $2
     RETURNING spent`,
    [id, cap, now],
  ));
  const row = rows[0] as { spent: number } | undefined;
  if (row) return { allowed: true, spent: Number(row.spent), cap };

  // Refused: the row is at or past the ceiling. Read it back so the caller can
  // say what was spent rather than only that something was.
  const { rows: held } = await table.guard(async () => (await db()).query(
    "SELECT spent FROM provider_spend WHERE id = $1", [id],
  ));
  return { allowed: false, spent: Number((held[0] as { spent: number } | undefined)?.spent ?? cap), cap };
}

/** What has been spent this month, for saying so without spending anything. */
export async function spentThisMonth(provider: string, now: number = Date.now()): Promise<number> {
  const { rows } = await table.guard(async () => (await db()).query(
    "SELECT spent FROM provider_spend WHERE id = $1", [`${provider}:${monthKey(now)}`],
  ));
  return Number((rows[0] as { spent: number } | undefined)?.spent ?? 0);
}
