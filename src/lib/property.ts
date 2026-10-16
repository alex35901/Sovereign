import { postJSON } from "./api";

/**
 * Home valuations via RentCast. Its Developer tier includes 50 lookups a
 * month, which is ample for a handful of properties refreshed monthly.
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

/** What one lookup is measured against: RentCast's included monthly requests. */
export const MONTHLY_LOOKUPS = 50;

/**
 * What the unattended schedule may spend in a month.
 *
 * It used to be the whole allowance bar a small reserve, on the reasoning that
 * going over was refused rather than billed, so spending it all cost nothing.
 * Both halves of that were wrong. A plan that bills for the requests past its
 * limit turns an aggressive schedule into a bill, and a schedule aimed at 84%
 * of the ceiling has no room for the ordinary ways a household spends more
 * than one device thinks it has: a second phone whose copy of the document is
 * an hour old, a write lost to a reconcile, a key pasted again on a laptop.
 * One of those takes 84% to over 100%, and the first anybody hears of it is
 * the provider's email.
 *
 * So the schedule is aimed at a fraction of the allowance and the rest is
 * headroom. A quarter of it is still a fresher figure than anybody reads.
 */
export const AUTO_MONTHLY_CAP = 12;

/**
 * The longest a property is left alone by the schedule.
 *
 * A house is the slowest-moving number in the app: an estimate that is a
 * fortnight old is the same estimate. Daily lookups bought nothing and cost
 * the allowance.
 */
export const AUTO_EVERY_HOURS = 14 * 24;

/** The average month, so a cadence in hours divides into it evenly enough. */
const HOURS_PER_MONTH = (365.25 / 12) * 24;

/**
 * Hours between automatic refreshes of one property.
 *
 * A fortnight each, and slower than that only when there are enough properties
 * for a fortnight each to run past the cap. Rounded up: overshooting the
 * interval spends fewer lookups than the budget, and undershooting spends
 * more than there are.
 */
export function refreshEveryHours(
  properties: number,
  cap: number = AUTO_MONTHLY_CAP,
): number {
  if (properties <= 0 || cap <= 0) return Infinity;
  return Math.max(AUTO_EVERY_HOURS, Math.ceil((HOURS_PER_MONTH * properties) / cap));
}

/**
 * Whether the schedule has anything left to spend this month.
 *
 * The cadence above is a rate and this is a ceiling, and the two answer
 * different failures. A rate is only as good as the clock it is read against,
 * and every device keeps its own; the count is one number in the document that
 * every device adds to. Checked immediately before the call, so whatever the
 * cadence thinks, the month's spending stops here.
 */
export const autoRoom = (usedThisMonth: number, cap: number = AUTO_MONTHLY_CAP): boolean =>
  usedThisMonth < cap;

/** What that cadence actually spends in a month, for saying so out loud. */
export function lookupsPerMonth(properties: number, everyHours: number): number {
  if (!Number.isFinite(everyHours) || everyHours <= 0) return 0;
  return Math.floor((HOURS_PER_MONTH / everyHours) * properties);
}

/** "every 12 hours" / "about daily" / "about every 14 days" */
export function cadenceLabel(hours: number): string {
  if (!Number.isFinite(hours)) return "never, too many properties for the free tier";
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
