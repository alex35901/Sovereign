import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { autoRoom, canValue, estimateHomeValue, propertyDue, refreshEveryHours } from "../lib/property";
import { meterOf, reason, recordRun } from "../lib/usage";

/**
 * Keeps property values current, well inside RentCast's allowance.
 *
 * Renders nothing. Every call here spends a lookup, and a lookup past the
 * plan's limit is now a charge rather than a refusal, so the design is about
 * spending few of them: a fortnight between refreshes of one property, one
 * property per tick so a burst of due ones cannot empty the allowance in a
 * minute, an attempt recorded whether or not it succeeded, and a hard stop at
 * the month's count however often anything here is asked.
 *
 * The stop is the part that holds when the rest does not. A cadence is read
 * against each device's own clock and its own copy of the document, so two
 * devices can both believe a property is due; the count is one number in the
 * document that both of them add to.
 */

/** How often to look at the clock. The cadence decides whether anything happens. */
const CHECK_MS = 10 * 60_000;
/**
 * How long to let a pasted key settle before acting on it.
 *
 * Typing one a character at a time would otherwise spend a lookup, out of
 * fifty a month, on a key that is not one yet.
 */
const SETTLE_MS = 2_000;

export function PropertyRefresh() {
  const { db, apply, actions } = useStore();

  // Read through refs, or the interval would tear down and restart on every
  // change to the database and never actually reach its next tick.
  const latest = useRef(db);
  latest.current = db;
  const act = useRef({ apply, actions });
  act.current = { apply, actions };

  const running = useRef(false);
  /** The round itself, so a key just pasted can start one without waiting. */
  const tick = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const round = async () => {
      if (running.current) return;
      const cur = latest.current;

      const key = cur.settings.rentcastApiKey?.trim();
      if (!key) return;

      // The month's ceiling, before the cadence is even consulted. Everything
      // below this line spends money.
      const used = meterOf(cur.settings.usage, "rentcast", "month").count;
      if (!autoRoom(used)) return;

      const properties = cur.accounts.filter(
        (a) => canValue(a.type) && !a.hidden && !a.closedAt && a.address?.trim(),
      );
      const every = refreshEveryHours(properties.length);
      // Oldest first, so a property never starves behind one that keeps failing.
      const due = properties
        .filter((a) => propertyDue(a, every))
        .sort((a, b) => (a.valuationTriedAt ?? a.valuation?.at ?? "").localeCompare(
          b.valuationTriedAt ?? b.valuation?.at ?? ""));
      const next = due[0];
      if (!next) return;

      running.current = true;
      try {
        // Stamped before the call, not after. A page closed mid-request would
        // otherwise leave nothing recorded and the same property would be asked
        // again on the next load, over and over.
        act.current.actions.updateAccount(next.id, { valuationTriedAt: new Date().toISOString() });

        const estimate = await estimateHomeValue(key, next.address ?? "");
        act.current.apply((d) => ({
          ...d,
          accounts: d.accounts.map((a) => (a.id === next.id
            ? {
                ...a,
                balance: estimate.value,
                valuation: { source: "rentcast" as const, low: estimate.low, high: estimate.high, at: estimate.asOf },
                valuationTriedAt: estimate.asOf,
                history: [...a.history.filter((h) => h.date !== estimate.asOf.slice(0, 10)),
                  { date: estimate.asOf.slice(0, 10), balance: estimate.value }]
                  .sort((x, y) => x.date.localeCompare(y.date)),
              }
            : a)),
        }), `value ${next.name}`);
        recordRun(act.current.apply, "rentcast", "month", { atLeast: estimate.spent });
      } catch (err) {
        recordRun(act.current.apply, "rentcast", "month", { error: reason(err, "The valuation failed.") });
        // The attempt is already stamped, so a bad address waits its full turn
        // rather than being retried immediately. Nothing is said out loud:
        // this runs unattended and a toast for it would only ever interrupt.
      } finally {
        running.current = false;
      }
    };

    tick.current = round;
    const id = window.setInterval(() => void round(), CHECK_MS);
    return () => window.clearInterval(id);
  }, []);

  // A key pasted into Settings used to sit there for up to ten minutes before
  // anything happened, which on a first setup reads as nothing happening at
  // all. Declared after the effect above, so the round is in place.
  const hasKey = Boolean(db.settings.rentcastApiKey?.trim());
  useEffect(() => {
    const id = window.setTimeout(() => void tick.current(), SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [hasKey]);

  return null;
}
