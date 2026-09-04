import type { DB } from "../types.js";
import { canValue } from "./property.js";
import { MONTHLY_LOOKUPS } from "./property.js";
import { MONTHLY_SYMBOLS, tickersOf } from "./prices.js";
import type { Period } from "./usage.js";
import { meterOf } from "./usage.js";
import { MONTHLY_TRANSFER, asMB, transferThisMonth } from "./transfer.js";

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
    | { kind: "server"; vars: string };
  set: boolean;
  used: number;
  ceiling: number;
  /** What `used` counts: "lookups", "symbols", "institutions". */
  unit: string;
  /** Shown under the ceiling when the figure needs qualifying. */
  caveat?: string;
  period: Period;
  /** When the provider was last called. */
  lastAt?: string;
  /** Worth saying out loud in the health column, beyond the ratio. */
  note?: string;
  error?: string;
}

export type Health = "ok" | "warn" | "down" | "off";

/** How far into an allowance counts as worth warning about. */
export const NEAR = 0.8;

export function healthOf(i: Integration): { state: Health; text: string } {
  if (!i.set) return { state: "off", text: "Not set up" };
  if (i.error) return { state: "down", text: i.error };
  if (i.ceiling > 0 && i.used >= i.ceiling) return { state: "down", text: `At the ${i.ceiling} ${i.unit} limit` };
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
      note: s.priceAutoRefresh === false ? "Automatic refresh is off" : undefined,
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
      note: s.propertyAutoRefresh === false
        ? "Automatic refresh is off"
        : addressless
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
      caveat: "measured in this browser",
      period: "month",
      lastAt: s.lastSyncAt,
      note: moved.calls > 20_000 ? `${moved.calls.toLocaleString()} requests this month — more than a sync should need` : undefined,
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
      note: staleJob(vercel.at, now),
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

/** A day and a half. Long enough that a job at 9am has clearly missed one. */
const STALE_MS = 36 * 3_600_000;

/**
 * Whether the scheduled job looks like it has stopped.
 *
 * This is the whole reason the Vercel row is worth a line: a cron that quietly
 * stops running is indistinguishable from a quiet week, and the balances just
 * go on being yesterday's.
 */
export function staleJob(at: string | undefined, now: number): string | undefined {
  if (!at) return "Hasn't run yet";
  const ran = Date.parse(at);
  if (!Number.isFinite(ran)) return "Hasn't run yet";
  return now - ran > STALE_MS ? "Hasn't run since " + at.slice(0, 10) : undefined;
}
