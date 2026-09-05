import type { ISODate, MonthKey } from "../types.js";

export const today = (): ISODate => new Date().toISOString().slice(0, 10);
export const monthOf = (d: ISODate): MonthKey => d.slice(0, 7);
export const thisMonth = (): MonthKey => today().slice(0, 7);

export function parseISO(d: ISODate): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day);
}
export const toISO = (d: Date): ISODate =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function addDays(d: ISODate, n: number): ISODate {
  const dt = parseISO(d);
  dt.setDate(dt.getDate() + n);
  return toISO(dt);
}
export function addMonths(key: MonthKey, n: number): MonthKey {
  const [y, m] = key.split("-").map(Number);
  const dt = new Date(y, m - 1 + n, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
}
export function addMonthsDate(d: ISODate, n: number): ISODate {
  const dt = parseISO(d);
  const day = dt.getDate();
  dt.setDate(1);
  dt.setMonth(dt.getMonth() + n);
  const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  dt.setDate(Math.min(day, last));
  return toISO(dt);
}
export const monthStart = (key: MonthKey): ISODate => `${key}-01`;
export function monthEnd(key: MonthKey): ISODate {
  const [y, m] = key.split("-").map(Number);
  return toISO(new Date(y, m, 0));
}
export function daysInMonth(key: MonthKey): number {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (key: MonthKey, short = false): string => {
  const [y, m] = key.split("-").map(Number);
  const name = MONTHS[m - 1];
  return short ? `${name.slice(0, 3)} ${String(y).slice(2)}` : `${name} ${y}`;
};
export function dateLabel(d: ISODate, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const dt = parseISO(d);
  return dt.toLocaleDateString("en-US", {
    weekday: opts.weekday ? "short" : undefined,
    month: "short",
    day: "numeric",
    year: opts.year ? "numeric" : undefined,
  });
}
/** "September 4, 2026" — for a detail screen, where the month has room to say
 *  its whole name and an abbreviation would only look abbreviated. */
export const longDate = (d: ISODate): string =>
  parseISO(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

export function relativeDay(d: ISODate): string {
  const diff = Math.round((parseISO(d).getTime() - parseISO(today()).getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return `In ${diff} days`;
  if (diff < -1 && diff > -7) return `${-diff} days ago`;
  return dateLabel(d);
}

/** Inclusive list of month keys from `from` to `to`. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  let cur = from;
  for (let i = 0; i < 600 && cur <= to; i++) { out.push(cur); cur = addMonths(cur, 1); }
  return out;
}
/** The last `n` months ending at `end` (inclusive). */
export const lastMonths = (n: number, end: MonthKey = thisMonth()): MonthKey[] =>
  monthRange(addMonths(end, -(n - 1)), end);

export function diffMonths(a: MonthKey, b: MonthKey): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}
