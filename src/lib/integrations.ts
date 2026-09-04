import type { DB } from "../types.js";
import { canValue } from "./property.js";
import { MONTHLY_LOOKUPS } from "./property.js";
import { MONTHLY_SYMBOLS, tickersOf } from "./prices.js";
import type { Period } from "./usage.js";
import { meterOf } from "./usage.js";

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
  ever: "connected",
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
