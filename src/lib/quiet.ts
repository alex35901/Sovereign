/**
 * Whether a run of activity has stopped, judged against its own rhythm.
 *
 * "When did it last run" and "when did it last bring something back" are
 * different questions, and only the second is about whether a connection
 * works. A bridge that answers every night with a fresh balance and an empty
 * transaction list stamps every clock the app keeps, reports no error, and
 * reads as connected for ever while nothing arrives.
 *
 * Judged against the account's own history rather than a fixed number of days,
 * because there is no fixed number right for both a card used twice a day and
 * a savings account used twice a year. The usual gap between days with
 * activity is the yardstick.
 */

/** The least silence worth remarking on, however chatty the account is. */
export const MIN_QUIET_DAYS = 4;

/** How far past its own normal gap counts as having stopped. */
const QUIET_MULTIPLE = 3;

/** Enough history to know what normal actually is. */
const ENOUGH = 6;

/** How far back to look when working out what normal is. */
const WINDOW = 60;

const DAY = 86_400_000;

export interface Quiet {
  /** The last day anything arrived. */
  since: string;
  /** How many days ago that was. */
  days: number;
  /** The usual gap between days with activity, in days. */
  usual: number;
}

/**
 * Silence worth mentioning, or undefined.
 *
 * Takes the dates rather than the transactions so the same rule can be asked
 * about one account or about every account on a connection, and cannot drift
 * between the two.
 */
export function quietFor(dates: readonly string[], now: number = Date.now()): Quiet | undefined {
  // Distinct days, newest first. Days rather than transactions, so a card used
  // five times on Saturday counts as one Saturday.
  const days = [...new Set(dates)].sort().reverse();
  if (days.length < ENOUGH) return undefined;

  const newest = Date.parse(`${days[0]}T00:00:00.000Z`);
  if (!Number.isFinite(newest) || newest > now) return undefined;

  // The typical gap, taken as a median so one holiday does not set the bar.
  const gaps: number[] = [];
  for (let i = 0; i < days.length - 1 && i < WINDOW; i++) {
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
