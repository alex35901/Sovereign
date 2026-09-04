import { db } from "./_store.js";

/**
 * What Hopper has cost so far today.
 *
 * A model that answers questions costs real money per question, and the one
 * failure mode nobody notices until the bill arrives is a loop that keeps
 * asking. So the count lives in Postgres rather than in memory: a serverless
 * function has no memory between calls, and a per-process counter would reset
 * on every cold start — which is to say, constantly.
 */

export interface Spend {
  day: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
}

/** How many questions a day is enough for one household. */
export const DAILY_MESSAGES = 120;

const today = (): string => new Date().toISOString().slice(0, 10);

let ready: Promise<void> | null = null;

/**
 * Creates the table, once, and survives two callers arriving together.
 *
 * `CREATE TABLE IF NOT EXISTS` is not actually safe against concurrency:
 * Postgres checks the catalogue and then inserts into it, and two statements
 * that interleave between those steps make the second one fail with a
 * duplicate key on pg_type rather than quietly doing nothing. A serverless
 * function that cold-starts under a burst hits this, and it surfaces as a
 * failed question rather than as anything that names the cause.
 */
async function ensureTable(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await (await db()).query(`
        CREATE TABLE IF NOT EXISTS hopper_usage (
          day date PRIMARY KEY,
          messages integer NOT NULL DEFAULT 0,
          input_tokens bigint NOT NULL DEFAULT 0,
          output_tokens bigint NOT NULL DEFAULT 0
        )
      `);
    } catch (err) {
      // Lost the race, which means the table is there — the only thing this
      // needed. Anything else is real, and the next call should try again.
      if (!/duplicate key|already exists/i.test(String(err))) {
        ready = null;
        throw err;
      }
    }
  })();
  return ready;
}

/** Only for tests, which drop the table between cases. */
export const forgetTable = (): void => { ready = null; };

const toSpend = (row: Record<string, unknown> | undefined, day: string): Spend => ({
  day,
  messages: Number(row?.messages ?? 0),
  inputTokens: Number(row?.input_tokens ?? 0),
  outputTokens: Number(row?.output_tokens ?? 0),
});

export async function spentToday(day: string = today()): Promise<Spend> {
  await ensureTable();
  const { rows } = await (await db()).query(
    "SELECT messages, input_tokens, output_tokens FROM hopper_usage WHERE day = $1", [day],
  );
  return toSpend(rows[0] as Record<string, unknown> | undefined, day);
}

/**
 * Claims one message against the day's allowance.
 *
 * The count goes up before the model is called, not after, and the check and
 * the increment are one statement: two questions asked at the same moment must
 * not both read "119 so far" and both be allowed.
 */
export async function claimMessage(day: string = today()): Promise<{ ok: boolean; spend: Spend }> {
  await ensureTable();
  const { rows } = await (await db()).query(
    `INSERT INTO hopper_usage (day, messages) VALUES ($1, 1)
     ON CONFLICT (day) DO UPDATE SET messages = hopper_usage.messages + 1
       WHERE hopper_usage.messages < $2
     RETURNING messages, input_tokens, output_tokens`,
    [day, DAILY_MESSAGES],
  );
  // No row back means the WHERE refused it: the allowance is already spent.
  if (!rows[0]) return { ok: false, spend: await spentToday(day) };
  return { ok: true, spend: toSpend(rows[0] as Record<string, unknown>, day) };
}

/** Records what the turn actually used, once the model has said so. */
export async function noteTokens(input: number, output: number, day: string = today()): Promise<void> {
  await ensureTable();
  await (await db()).query(
    `UPDATE hopper_usage SET input_tokens = input_tokens + $2, output_tokens = output_tokens + $3
     WHERE day = $1`,
    [day, Math.max(0, input), Math.max(0, output)],
  );
}
