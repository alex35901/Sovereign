import type { Account, DB, ISODate, VehicleProfile } from "../types";
import { addDays, parseISO, today } from "./date";

/**
 * Modelled vehicle depreciation.
 *
 * There is no free per-VIN valuation API — KBB and Edmunds retired their public
 * ones, and the paid providers don't publish pricing. So rather than pretend to
 * quote the market, this projects a curve from what the vehicle cost and when it
 * was bought.
 *
 * Five-year retention figures come from 2026 industry data: the average vehicle
 * loses 41.8% over five years, trucks 34.2%, hybrids 35.4%, EVs 57.2%. The first
 * year is the steepest drop; the remaining years are fitted so the curve lands on
 * the five-year figure.
 */
export type VehicleClass = VehicleProfile["class"];

/** [label, retention after year one, retention after five years] */
const CURVES: Record<VehicleClass, { label: string; firstYear: number; fiveYear: number }> = {
  car: { label: "Car / sedan", firstYear: 0.80, fiveYear: 0.582 },
  suv: { label: "SUV / crossover", firstYear: 0.83, fiveYear: 0.62 },
  truck: { label: "Truck", firstYear: 0.85, fiveYear: 0.658 },
  hybrid: { label: "Hybrid", firstYear: 0.84, fiveYear: 0.646 },
  ev: { label: "Electric", firstYear: 0.72, fiveYear: 0.428 },
  luxury: { label: "Luxury", firstYear: 0.75, fiveYear: 0.50 },
};

export const VEHICLE_CLASSES = (Object.keys(CURVES) as VehicleClass[]).map((value) => ({
  value,
  label: CURVES[value].label,
}));

/** A vehicle keeps some value as parts and scrap however old it gets. */
const FLOOR = 0.08;
const BASELINE_MILES = 12_000;

export function retentionAt(vehicleClass: VehicleClass, years: number): number {
  const curve = CURVES[vehicleClass] ?? CURVES.car;
  if (years <= 0) return 1;
  if (years <= 1) return 1 - (1 - curve.firstYear) * years;
  // the annual factor that carries year one's value to the five-year figure
  const annual = (curve.fiveYear / curve.firstYear) ** (1 / 4);
  return Math.max(FLOOR, curve.firstYear * annual ** (years - 1));
}

/** Mileage moves the vehicle along its own curve faster or slower. */
export function effectiveYears(profile: VehicleProfile, asOf: ISODate): number {
  const days = (parseISO(asOf).getTime() - parseISO(profile.purchaseDate).getTime()) / 86400000;
  const years = Math.max(0, days / 365.25);
  const miles = profile.annualMiles ?? BASELINE_MILES;
  const wear = Math.min(2, Math.max(0.5, miles / BASELINE_MILES));
  return years * wear;
}

export function estimateVehicleValue(profile: VehicleProfile, asOf: ISODate = today()): number {
  return Math.round(profile.purchasePrice * retentionAt(profile.class, effectiveYears(profile, asOf)));
}

/** Twelve months of the curve, for the preview chart. */
export function projection(profile: VehicleProfile, months = 12): { date: ISODate; value: number }[] {
  const out: { date: ISODate; value: number }[] = [];
  for (let m = 0; m <= months; m++) {
    const date = addDays(today(), Math.round(m * 30.44));
    out.push({ date, value: estimateVehicleValue(profile, date) });
  }
  return out;
}

const STALE_DAYS = 25;

export const vehicleNeedsRefresh = (account: Account, asOf: ISODate = today()): boolean => {
  if (!account.vehicle?.autoUpdate) return false;
  const newest = account.history[account.history.length - 1];
  if (!newest) return true;
  return newest.date <= addDays(asOf, -STALE_DAYS);
};

/**
 * Records this month's modelled value for any vehicle due one. Returns the same
 * database object when nothing is stale, so callers can run it on every load.
 */
export function refreshVehicleValues(db: DB, asOf: ISODate = today()): DB {
  const due = db.accounts.filter((a) => vehicleNeedsRefresh(a, asOf));
  if (!due.length) return db;

  const ids = new Set(due.map((a) => a.id));
  return {
    ...db,
    accounts: db.accounts.map((a) => {
      if (!ids.has(a.id) || !a.vehicle) return a;
      const value = estimateVehicleValue(a.vehicle, asOf);
      const history = [...a.history.filter((h) => h.date !== asOf), { date: asOf, balance: value }]
        .sort((x, y) => (x.date < y.date ? -1 : 1));
      return { ...a, history, balance: history[history.length - 1].balance };
    }),
  };
}
