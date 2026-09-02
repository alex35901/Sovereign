import { postJSON } from "./api";

/**
 * Home valuations via RentCast. Its Developer tier is free for 50 lookups a
 * month, which is ample for a handful of properties refreshed monthly — MX
 * (and so SimpleFIN) carries no property values at all.
 */
export interface ValueEstimate {
  /** cents */
  value: number;
  low?: number;
  high?: number;
  asOf: string;
  address: string;
}

interface ProxyResult {
  price: number;
  priceRangeLow?: number;
  priceRangeHigh?: number;
  address?: string;
}

const toCents = (dollars: number | undefined): number | undefined =>
  typeof dollars === "number" && Number.isFinite(dollars) ? Math.round(dollars * 100) : undefined;

export async function estimateHomeValue(apiKey: string, address: string): Promise<ValueEstimate> {
  const clean = address.trim();
  if (!apiKey.trim()) throw new Error("Add your RentCast API key in Settings first.");
  if (!clean) throw new Error("Enter the property address first.");

  const raw = await postJSON<ProxyResult>("/api/property", { apiKey: apiKey.trim(), address: clean });
  const value = toCents(raw.price);
  if (value === undefined) throw new Error("RentCast returned no value for that address.");

  return {
    value,
    low: toCents(raw.priceRangeLow),
    high: toCents(raw.priceRangeHigh),
    asOf: new Date().toISOString(),
    address: raw.address ?? clean,
  };
}

export const PROPERTY_TYPES = ["real_estate", "other_asset"] as const;
export const canValue = (type: string): boolean => (PROPERTY_TYPES as readonly string[]).includes(type);

/* ── how often to ask ─────────────────────────────────────────────────── */

/**
 * RentCast's Developer tier allows this many lookups a month, and one
 * valuation is one lookup. Going over does not bill — it refuses — so the
 * budget is a hard ceiling rather than a cost to trade off.
 */
export const MONTHLY_LOOKUPS = 50;

/**
 * Kept back from the automatic schedule so pressing "Update now" always works.
 * Without a reserve the schedule would spend the whole allowance and the
 * button would fail for the rest of the month, which is the one moment you
 * actually want a fresh figure.
 */
export const MANUAL_RESERVE = 6;

/** The average month, so a cadence in hours divides into it evenly enough. */
const HOURS_PER_MONTH = (365.25 / 12) * 24;

/**
 * Hours between automatic refreshes of one property.
 *
 * Derived rather than fixed, so adding a third property slows all three down
 * instead of quietly running past the allowance. Rounded up: overshooting the
 * interval spends fewer lookups than the budget, and undershooting spends
 * more than there are.
 */
export function refreshEveryHours(
  properties: number,
  budget: number = MONTHLY_LOOKUPS - MANUAL_RESERVE,
): number {
  if (properties <= 0 || budget <= 0) return Infinity;
  const perProperty = budget / properties;
  if (perProperty < 1) return Infinity; // more properties than the tier allows
  return Math.ceil(HOURS_PER_MONTH / perProperty);
}

/** What that cadence actually spends in a month, for saying so out loud. */
export function lookupsPerMonth(properties: number, everyHours: number): number {
  if (!Number.isFinite(everyHours) || everyHours <= 0) return 0;
  return Math.floor((HOURS_PER_MONTH / everyHours) * properties);
}

/** "every 34 hours" / "daily" / "every 3 days" */
export function cadenceLabel(hours: number): string {
  if (!Number.isFinite(hours)) return "never — too many properties for the free tier";
  if (hours < 24) return `every ${hours} hours`;
  if (hours < 36) return "about daily";
  const days = Math.round(hours / 24);
  return days === 1 ? "about daily" : `about every ${days} days`;
}

export interface Valued {
  address?: string;
  valuation?: { at: string };
  /** When a refresh was last attempted, successful or not. */
  valuationTriedAt?: string;
}

/**
 * Whether a property is due.
 *
 * The attempt is what ages, not the success: a property whose address RentCast
 * cannot find would otherwise be retried on every single tick, burning the
 * allowance on an answer that is never going to come.
 */
export function propertyDue(a: Valued, everyHours: number, now: number = Date.now()): boolean {
  if (!a.address?.trim()) return false;
  if (!Number.isFinite(everyHours)) return false;
  const last = a.valuationTriedAt ?? a.valuation?.at;
  if (!last) return true;
  const at = Date.parse(last);
  if (!Number.isFinite(at)) return true;
  return now - at >= everyHours * 3600_000;
}
