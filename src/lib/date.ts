import type { ISODate, MonthKey } from "../types.js";

export function parseISO(d: ISODate): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day);
}
export const toISO = (d: Date): ISODate =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The date on the wall, not the date in Greenwich.
 *
 * Every other function here works in local time - parseISO builds a local
 * Date, toISO reads local getters - and this used to be the one that did not:
 * it took toISOString, which is UTC. West of Greenwich that makes the app a
 * day early every evening. At half six on the 30th in California it said the
 * 1st, so "this month" became next month, the budget emptied, the dashboard
 * reported a month that had not started, and a charge made an hour ago read as
 * "Yesterday". East of Greenwich the same fault runs the other way, early in
 * the morning.
 *
 * A day is a thing that happens where the person is. Nothing in this app is
 * about Greenwich.
 */
export const today = (): ISODate => toISO(new Date());
export const monthOf = (d: ISODate): MonthKey => d.slice(0, 7);
export const thisMonth = (): MonthKey => today().slice(0, 7);

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

/**
 * How long ago, in one or two characters plus a unit.
 *
 * For a line that already carries the account's name, its kind and its
 * balance: "13h ago" fits where "September 4, 2026 at 11:42" does not, and
 * the only question being asked of it is whether the figure beside it is
 * fresh. Anything older than a week is a date, because by then the
 * difference between nine days and eleven has stopped mattering.
 */
export function sinceLabel(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.floor((now.getTime() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return dateLabel(iso.slice(0, 10), { year: now.getFullYear() !== new Date(then).getFullYear() });
}

export function relativeDay(d: ISODate): string {
  const diff = Math.round((parseISO(d).getTime() - parseISO(today()).getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return `In ${diff} days`;
  if (diff < -1 && diff > -7) return `${-diff} days ago`;
  return dateLabel(d);
}

/**
 * The same, set into the middle of a sentence.
 *
 * "next today", not "next Today" — but "next Sep 17", not "next sep 17": a
 * month is a proper noun wherever it lands, and only the phrases were
 * capitalised for the start of a line in the first place.
 */
export function relativeDayMid(d: ISODate): string {
  const label = relativeDay(d);
  if (label === dateLabel(d)) return label;
  return label.charAt(0).toLowerCase() + label.slice(1);
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
