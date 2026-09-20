import type { DB } from "../types.js";
import { canValue } from "./property.js";
import { MONTHLY_LOOKUPS } from "./property.js";
import { MONTHLY_SYMBOLS, tickersOf } from "./prices.js";
import type { Period } from "./usage.js";
import { meterOf } from "./usage.js";
import { MONTHLY_ORIGIN_TRANSFER, MONTHLY_TRANSFER, asMB, documentMB, transferThisMonth } from "./transfer.js";

/**
 * One row of the integrations table.
 *
 * The point of gathering these in one place is that every provider has a
 * different allowance measured in a different thing over a different period —
 * institutions that never reset, lookups that reset monthly, questions that
 * reset at midnight — and a table with a single "calls" column would have to
 * lie about at least three of them. So each row carries its own unit and its
 * own period, and the table prints what the row says.
 */
export interface Integration {
  id: string;
  /** What it does for the app, not what it is. */
  process: string;
  provider: string;
  /**
   * Where the credential is. Three shapes, because they genuinely differ: two
   * providers take a key you paste, SimpleFIN takes a one-use setup token that
   * is exchanged for an access URL, and two hold their credentials on the
   * server where the browser must never see them.
   */
  credential:
    | { kind: "field"; field: "rentcastApiKey" | "tiingoApiKey"; placeholder: string }
    | { kind: "claimed"; held: string; where: string }
    | { kind: "server"; vars: string }
    /** No credential of its own: it is the platform everything else runs on. */
    | { kind: "platform"; what: string };
  set: boolean;
  used: number;
  ceiling: number;
  /** What `used` counts: "lookups", "symbols", "institutions". */
  unit: string;
  /** Shown under the ceiling when the figure needs qualifying. */
  caveat?: string;
  /**
   * When this connection last brought something back, if that is longer ago
   * than its own normal. Separate from `lastAt`, which is only when it last
   * tried: a pull that succeeds and returns nothing moves one and not the
   * other, and it is the other that says whether the connection works.
   */
  quiet?: { since: string; days: number; usual: number };
  period: Period;
  /** When the provider was last called. */
  lastAt?: string;
  /**
   * How long this one may go without running before that is worth saying. A
   * nightly job has clearly missed one after a day and a half; a bank on a
   * weekly cadence has not. Left unset, the generic ceiling below applies.
   */
  staleAfterHours?: number;
  /**
   * What to say when it has never run at all, for the rows where that is
   * already wrong. The scheduled job is one: it should have run last night.
   * A bank connected a moment ago is not, and saying so would mean every new
   * connection announced itself as broken before its first pull finished.
   */
  neverRun?: string;
  /** Worth saying out loud in the health column, beyond the ratio. */
  note?: string;
  error?: string;
}

export type Health = "ok" | "warn" | "down" | "off";

/** How far into an allowance counts as worth warning about. */
export const NEAR = 0.8;

/**
 * How long a provider with no schedule of its own may go quiet.
 *
 * Longer than the slowest cadence anything here runs on, which is weekly, so
 * a provider that is simply not busy is never called broken.
 */
export const STALE_HOURS = 14 * 24;

/**
 * Whether this provider looks like it has quietly stopped.
 *
 * The failure this exists for is the silent one. A connection that breaks with
 * an error announces itself; one that simply stops being called leaves a row
 * that looks perfectly healthy and is doing nothing, and the only sign is a
 * date nobody was looking at. It began as the Vercel row's alone, because a
 * cron that stops looks exactly like a quiet week, and every other provider
 * here can stop just as quietly.
 */
export function staleSince(i: Integration, now: number = Date.now()): string | undefined {
  if (!i.set || i.error) return undefined;
  // Only a row that says so treats never having run as a fault. For
  // everything else, never having run means newly set up.
  if (!i.lastAt) return i.neverRun;
  const ran = Date.parse(i.lastAt);
  if (!Number.isFinite(ran)) return i.neverRun;
  // A stamp from the future is a clock that jumped, not a provider at rest.
  if (ran > now) return undefined;
  const hours = i.staleAfterHours ?? STALE_HOURS;
  return now - ran > hours * 3_600_000 ? `Hasn't run since ${i.lastAt.slice(0, 10)}` : undefined;
}

/**
 * The least silence worth remarking on, however chatty the connection is.
 *
 * Four days, so a long weekend where nobody spends anything is not reported as
 * a fault.
 */
export const MIN_QUIET_DAYS = 4;

/** How far past a connection's own normal gap counts as it having stopped. */
const QUIET_MULTIPLE = 3;

/** Enough history to know what this connection's normal actually is. */
const ENOUGH = 6;

const DAY = 86_400_000;

/**
 * Whether a connection has gone quiet, judged against its own usual rhythm.
 *
 * "When did it last run" and "when did it last bring something back" are
 * different questions, and only the second one is about whether the
 * connection works. A bridge that answers every night and returns an empty
 * list stamps its clock, reports no error, and reads as healthy for ever
 * while nothing arrives. The visible symptom is a budget where a month's
 * income never shows up, and a row in Settings that says Healthy.
 *
 * Judged against this connection's own history rather than a fixed number of
 * days, because there is no fixed number that is right for both a card used
 * twice a day and a savings account used twice a year. The usual gap between
 * days with activity is the yardstick: silence of three times that, and at
 * least four days, is worth saying. A connection without enough history to
 * have a usual gap is not guessed at.
 */
export function quietSince(
  db: DB,
  source: "simplefin" | "plaid",
  now: number = Date.now(),
): { since: string; days: number; usual: number } | undefined {
  const ids = new Set(
    db.accounts.filter((a) => a.syncSource === source && !a.closedAt).map((a) => a.id),
  );
  if (!ids.size) return undefined;

  // Distinct days with activity, newest first. Days rather than transactions,
  // so a card used five times on Saturday counts as one Saturday.
  const days = [...new Set(
    db.transactions.filter((t) => ids.has(t.accountId)).map((t) => t.date),
  )].sort().reverse();
  if (days.length < ENOUGH) return undefined;

  const newest = Date.parse(`${days[0]}T00:00:00.000Z`);
  if (!Number.isFinite(newest) || newest > now) return undefined;

  // The typical gap, taken as a median so one holiday does not set the bar.
  const gaps: number[] = [];
  for (let i = 0; i < days.length - 1 && i < 60; i++) {
    const a = Date.parse(`${days[i]}T00:00:00.000Z`);
    const b = Date.parse(`${days[i + 1]}T00:00:00.000Z`);
    if (Number.isFinite(a) && Number.isFinite(b)) gaps.push((a - b) / DAY);
  }
  if (!gaps.length) return undefined;
  gaps.sort((x, y) => x - y);
  const usual = Math.max(1, gaps[Math.floor(gaps.length / 2)]!);

  const quiet = Math.floor((now - newest) / DAY);
  if (quiet < Math.max(MIN_QUIET_DAYS, usual * QUIET_MULTIPLE)) return undefined;
  return { since: days[0]!, days: quiet, usual };
}

export function healthOf(i: Integration, now: number = Date.now()): { state: Health; text: string } {
  if (!i.set) return { state: "off", text: "Not set up" };
  if (i.error) return { state: "down", text: i.error };
  if (i.ceiling > 0 && i.used >= i.ceiling) return { state: "down", text: `At the ${i.ceiling} ${i.unit} limit` };
  // Before the allowance warning: a provider at rest is a worse problem than
  // one three quarters of the way through a budget it is plainly spending.
  const resting = staleSince(i, now);
  if (resting) return { state: "warn", text: resting };
  // It has been running. It just has not brought anything back, which is the
  // failure that looks exactly like a quiet fortnight.
  if (i.quiet) return { state: "warn", text: `Nothing new since ${i.quiet.since}` };
  // An allowance about to run out outranks a note: one of them stops the
  // integration working this week and the other is a preference.
  if (i.ceiling > 0 && i.used >= i.ceiling * NEAR) return { state: "warn", text: `Near the ${i.unit} limit` };
  if (i.note) return { state: "warn", text: i.note };
  return { state: "ok", text: "Healthy" };
}

export const PERIOD_LABEL: Record<Period, string> = {
  day: "today",
  month: "this month",
  // A ceiling on how many things may exist at once has no period to name.
  ever: "",
};

/** Hopper's usage lives on the server; the browser is told it rather than counting. */
export interface HopperSpend { messages: number; limit: number; at?: string }

export function integrations(db: DB, hopper?: HopperSpend | null, now: number = Date.now()): Integration[] {
  const s = db.settings;
  const usage = s.usage;

  const banks = new Set(
    db.accounts.filter((a) => a.syncSource === "simplefin" && !a.closedAt).map((a) => a.institution.trim().toLowerCase()),
  );
  banks.delete("");

  const plaidItems = s.plaidItems ?? [];
  const plaidLast = plaidItems
    .map((i) => i.lastSyncAt ?? "")
    .filter(Boolean)
    .sort()
    .at(-1);

  const properties = db.accounts.filter((a) => canValue(a.type) && !a.hidden && !a.closedAt);
  const addressless = properties.filter((a) => !a.address?.trim()).length;

  const moved = transferThisMonth(now);
  const vercel = meterOf(usage, "vercel", "month", now);
  // Both of these are the deployment rather than a key someone pastes, so
  // "set up" means the app has actually talked to it: bytes over the API this
  // month, or a scheduled run recorded at some point.
  const cloud = moved.calls > 0 || Boolean(vercel.at);
  // What one save costs, which is what makes the allowance legible: an
  // allowance in gigabytes means nothing until you know the unit it is spent in.
  const perSave = documentMB(db);
  const simplefin = meterOf(usage, "simplefin", "ever", now);
  const plaid = meterOf(usage, "plaid", "ever", now);
  const tiingo = meterOf(usage, "tiingo", "month", now);
  const rentcast = meterOf(usage, "rentcast", "month", now);

  return [
    {
      id: "simplefin",
      process: "Bank sync",
      provider: "SimpleFIN Bridge",
      credential: { kind: "claimed", held: "Access URL", where: "Bank sync" },
      set: Boolean(s.simplefinAccessUrl?.trim()),
      // The subscription caps how many banks may be linked at the bridge, not
      // how often they are asked, so the meter is the banks and not the calls.
      used: banks.size,
      ceiling: 25,
      unit: "institutions",
      period: "ever",
      lastAt: s.lastSyncAt,
      // A nightly job and a browser that syncs on its own cadence: three days
      // with no attempt at all is not a quiet week, it is nothing running.
      staleAfterHours: 72,
      quiet: quietSince(db, "simplefin", now),
      error: simplefin.error,
    },
    {
      id: "plaid",
      process: "Investment sync",
      provider: "Plaid",
      credential: { kind: "server", vars: "PLAID_CLIENT_ID / PLAID_SECRET" },
      set: plaidItems.length > 0,
      used: plaidItems.length,
      ceiling: 10,
      unit: "items",
      period: "ever",
      lastAt: plaidLast,
      staleAfterHours: 72,
      quiet: quietSince(db, "plaid", now),
      error: plaid.error,
    },
    {
      id: "tiingo",
      process: "Holding prices",
      provider: "Tiingo",
      credential: { kind: "field", field: "tiingoApiKey", placeholder: "Paste API token" },
      set: Boolean(s.tiingoApiKey?.trim()),
      // Tiingo charges by the distinct symbol, however often each is asked
      // about, so this is the set seen this month and not the request count.
      used: tiingo.count,
      ceiling: MONTHLY_SYMBOLS,
      unit: "symbols",
      period: "month",
      lastAt: s.lastPricesAt,
      note: undefined,
      error: tiingo.error,
    },
    {
      id: "rentcast",
      process: "Property values",
      provider: "RentCast",
      credential: { kind: "field", field: "rentcastApiKey", placeholder: "Paste API key" },
      set: Boolean(s.rentcastApiKey?.trim()),
      used: rentcast.count,
      ceiling: MONTHLY_LOOKUPS,
      unit: "lookups",
      period: "month",
      lastAt: rentcast.at,
      note: addressless
        ? `${addressless} propert${addressless === 1 ? "y has" : "ies have"} no address`
        : undefined,
      error: rentcast.error,
    },
    {
      id: "neon",
      process: "Cloud database",
      provider: "Neon",
      credential: { kind: "server", vars: "DATABASE_URL" },
      set: cloud,
      // Bytes over this app's own API, which is the traffic that drives Neon's
      // bill rather than the figure Neon itself meters. Close, and not the
      // same, so the table says where it came from.
      used: asMB(moved.bytes),
      ceiling: asMB(MONTHLY_TRANSFER),
      unit: "MB transferred",
      caveat: perSave ? `measured here · ${perSave} MB per save` : "measured in this browser",
      period: "month",
      lastAt: s.lastSyncAt,
      note: moved.calls > 20_000 ? `${moved.calls.toLocaleString()} requests this month, more than a sync should need` : undefined,
    },
    {
      id: "vercel-transfer",
      process: "Origin transfer",
      provider: "Vercel",
      credential: { kind: "platform", what: "the deployment itself" },
      set: cloud,
      // The same bytes the Neon row counts. They are metered twice, by two
      // companies, against two different ceilings — and the smaller allowance
      // is not the one that runs out first, because Vercel counts the request
      // going up as well as the answer coming back.
      used: asMB(moved.bytes),
      ceiling: asMB(MONTHLY_ORIGIN_TRANSFER),
      unit: "MB transferred",
      caveat: perSave ? `measured here · ${perSave} MB per save` : "measured in this browser",
      period: "month",
      lastAt: s.lastSyncAt,
    },
    {
      id: "vercel",
      process: "Scheduled job",
      provider: "Vercel",
      credential: { kind: "server", vars: "CRON_SECRET" },
      set: cloud,
      // The Hobby plan allows two jobs at once a day, and this app runs one.
      // The number is static; what is worth reading is the column beside it,
      // because a cron that quietly stops looks exactly like a quiet week.
      used: 1,
      ceiling: 2,
      unit: "daily jobs",
      period: "ever",
      lastAt: vercel.at,
      // A day and a half: long enough that a job due at nine has clearly
      // missed one, and a job that has never run at all is already wrong.
      staleAfterHours: 36,
      neverRun: "Hasn't run yet",
    },
    {
      id: "anthropic",
      process: "Hopper",
      provider: "Anthropic",
      credential: { kind: "server", vars: "ANTHROPIC_API_KEY" },
      set: Boolean(hopper),
      used: hopper?.messages ?? 0,
      ceiling: hopper?.limit ?? 0,
      unit: "questions",
      period: "day",
      lastAt: db.hopper?.at(-1)?.at,
    },
  ];
}

/** The tickers a price run would ask about — what the Tiingo meter will record. */
export const pricedSymbols = (db: DB): string[] => tickersOf(db.holdings);

