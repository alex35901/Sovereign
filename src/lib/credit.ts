import type { DB, ISODate } from "../types.js";

/**
 * Credit scores, kept as dated readings.
 *
 * No provider is wired up. This is the plumbing: somewhere to put the
 * readings, the arithmetic to read them back, and a way to enter one by hand —
 * so the card works from the day it ships and a provider, when there is one,
 * has only to append to the same array.
 *
 * Dated readings rather than a single current score, because the shape of a
 * score over a year is the part worth looking at; a number on its own only
 * tells you what today is like, which you can also get by asking the bureau.
 *
 * FICO's scale, which is what the American bureaux report and what the bands
 * below are drawn from. A provider reporting VantageScore uses the same 300 to
 * 850 range, so the chart holds either; the band names differ slightly between
 * them and these are FICO's.
 */

export interface CreditReading {
  date: ISODate;
  score: number;
  /**
   * Whose score it is.
   *
   * A household has more than one, and two people's scores on one chart is
   * two different stories drawn as one. Left off on readings recorded before
   * there was anyone to name, which is what `WHOEVER` stands in for.
   */
  who?: string;
  /** Where it came from — a bureau's name, or left off when typed in. */
  source?: string;
}

/** What an unnamed reading is filed under, so one person needs no setup. */
export const WHOEVER = "You";

export const whoOf = (r: CreditReading): string => r.who?.trim() || WHOEVER;

export const CREDIT_MIN = 300;
export const CREDIT_MAX = 850;

/** The bands, by the lowest score that reaches each. */
export const CREDIT_BANDS: { from: number; label: string; tone: string }[] = [
  { from: 800, label: "Excellent", tone: "--pos" },
  { from: 740, label: "Very good", tone: "--c3" },
  { from: 670, label: "Good", tone: "--c5" },
  { from: 580, label: "Fair", tone: "--c9" },
  { from: CREDIT_MIN, label: "Poor", tone: "--neg" },
];

export function bandOf(score: number): { label: string; tone: string } {
  const band = CREDIT_BANDS.find((b) => score >= b.from);
  return band ?? CREDIT_BANDS[CREDIT_BANDS.length - 1];
}

export interface CreditSummary {
  readings: CreditReading[];
  latest?: CreditReading;
  /** Against the reading before it, which is the one a card reports. */
  change: number;
  band?: { label: string; tone: string };
  /** Where the latest score sits on the scale, 0 to 1, for the meter. */
  position: number;
}

/**
 * The readings in order, oldest first, with the newest picked out.
 *
 * Sorted here rather than trusted: readings can arrive from a provider out of
 * order, or be typed in for a month already past, and a chart drawn from an
 * unsorted array is a chart that zigzags for reasons that are not the score's.
 */
/**
 * Everyone with a score on file, in the order they first appear.
 *
 * Not sorted alphabetically: whoever set the budget up is the one who will
 * look at it most, and they are the one whose reading went in first.
 */
export function creditPeople(db: DB): string[] {
  const out: string[] = [];
  for (const r of db.credit ?? []) {
    const who = whoOf(r);
    if (!out.includes(who)) out.push(who);
  }
  return out;
}

export function creditSummary(db: DB, who?: string): CreditSummary {
  const all = db.credit ?? [];
  const mine = who === undefined ? all : all.filter((r) => whoOf(r) === who);
  const readings = [...mine].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const latest = readings[readings.length - 1];
  const previous = readings[readings.length - 2];
  if (!latest) return { readings, change: 0, position: 0 };
  return {
    readings,
    latest,
    change: previous ? latest.score - previous.score : 0,
    band: bandOf(latest.score),
    position: Math.max(0, Math.min(1, (latest.score - CREDIT_MIN) / (CREDIT_MAX - CREDIT_MIN))),
  };
}

/**
 * Records a reading, replacing any already held for that day.
 *
 * One per day by design: a provider polled twice in an afternoon should not
 * put two points on the chart a pixel apart, and a correction typed in after
 * a mistake should replace the mistake rather than sit beside it.
 */
export function recordCredit(db: DB, reading: CreditReading): DB {
  // Per person, per day: two people's scores on the same date are two
  // readings, and replacing one with the other would lose a person.
  const who = whoOf(reading);
  const rest = (db.credit ?? []).filter((r) => !(r.date === reading.date && whoOf(r) === who));
  return {
    ...db,
    credit: [...rest, reading].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
  };
}
