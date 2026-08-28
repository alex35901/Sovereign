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
