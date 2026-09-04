/**
 * When an automatic sync falls due.
 *
 * There is no server here — the whole app is this browser tab — so a schedule
 * can only mean "sync when the app is open and one is owed". Nothing runs
 * while the tab is closed; the first check after opening catches up instead.
 */

export type SyncCadence = "off" | "open" | "hourly" | "6h" | "daily" | "weekly";

export const CADENCES: { value: SyncCadence; label: string; hours: number | null }[] = [
  { value: "off", label: "Never — I'll sync by hand", hours: null },
  { value: "open", label: "Whenever I open the app", hours: 0 },
  { value: "hourly", label: "Every hour", hours: 1 },
  { value: "6h", label: "Every 6 hours", hours: 6 },
  { value: "daily", label: "Once a day", hours: 24 },
  { value: "weekly", label: "Once a week", hours: 168 },
];

/** SimpleFIN's own upstream refresh is roughly daily, so this is the sweet spot. */
export const DEFAULT_CADENCE: SyncCadence = "daily";

const HOUR = 3_600_000;

export function cadenceHours(cadence: SyncCadence): number | null {
  return CADENCES.find((c) => c.value === cadence)?.hours ?? null;
}

export function cadenceLabel(cadence: SyncCadence): string {
  return CADENCES.find((c) => c.value === cadence)?.label ?? "Never";
}

const stamp = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * Whether a sync is owed right now.
 *
 * `sessionStart` is when this page was loaded, which is what makes "whenever I
 * open the app" fire once per visit rather than on every check.
 */
export function syncDue(
  cadence: SyncCadence,
  lastSyncAt: string | undefined,
  now: number,
  sessionStart: number,
): boolean {
  const hours = cadenceHours(cadence);
  if (hours === null) return false;
  const last = stamp(lastSyncAt);
  if (last === null) return true; // never synced
  if (last > now) return false; // a clock that jumped; don't stampede
  if (hours === 0) return last < sessionStart;
  return now - last >= hours * HOUR;
}

/** When the next sync falls due, in epoch ms. Null when nothing is scheduled. */
export function nextSyncAt(cadence: SyncCadence, lastSyncAt: string | undefined): number | null {
  const hours = cadenceHours(cadence);
  if (hours === null || hours === 0) return null;
  const last = stamp(lastSyncAt);
  if (last === null) return null;
  return last + hours * HOUR;
}

/** "in 3 hours", "in 2 days", "now" — for the line under the picker. */
export function untilLabel(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins} minute${mins === 1 ? "" : "s"}`;
  const hrs = Math.round(ms / HOUR);
  if (hrs < 48) return `in ${hrs} hour${hrs === 1 ? "" : "s"}`;
  const days = Math.round(ms / (24 * HOUR));
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/* ── how often the document is sent ───────────────────────────────────── */

/**
 * How long edits have to stop before the document is saved to the cloud.
 *
 * The whole document goes up on every save — it is one encrypted blob, there
 * is no delta format — so the number of saves is the bill, twice over: Neon
 * meters the traffic and so does Vercel. At a second and a half, categorising
 * forty transactions was forty copies of the budget, and a single evening of
 * tidying could move more than a month of everything else.
 */
export const PUSH_QUIET_MS = 8_000;

/**
 * However busy the typing, unsent work never waits longer than this.
 *
 * Without a ceiling a steady stream of small edits keeps resetting the timer
 * and nothing reaches the server at all.
 */
export const PUSH_MAX_WAIT_MS = 30_000;

/**
 * How long to wait before saving, given when the oldest unsent edit was made.
 *
 * Quiet is measured from the last edit and the ceiling from the first, so a
 * burst coalesces into one save and a long stretch of steady work still gets
 * one every half minute.
 */
export function saveDelay(firstEditAt: number, now: number = Date.now()): number {
  if (!firstEditAt) return PUSH_QUIET_MS;
  // A clock that jumped backwards makes this negative, which only ever widens
  // the ceiling — so the quiet period wins and nothing stalls.
  const waited = now - firstEditAt;
  return Math.max(0, Math.min(PUSH_QUIET_MS, PUSH_MAX_WAIT_MS - waited));
}
