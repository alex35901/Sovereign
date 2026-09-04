import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { canValue, estimateHomeValue, propertyDue, refreshEveryHours } from "../lib/property";
import { reason, recordRun } from "../lib/usage";

/**
 * Keeps property values current, within RentCast's free allowance.
 *
 * Renders nothing. Every call here spends one of fifty lookups a month, so the
 * design is about not wasting them: the cadence is worked out from how many
 * properties there are rather than fixed, an attempt is recorded whether or not
 * it succeeded, and only one property is refreshed per tick so a burst of due
 * ones cannot empty the allowance in a single minute.
 */

/** How often to look at the clock. The cadence decides whether anything happens. */
const CHECK_MS = 10 * 60_000;

export function PropertyRefresh() {
  const { db, apply, actions } = useStore();

  // Read through refs, or the interval would tear down and restart on every
  // change to the database and never actually reach its next tick.
  const latest = useRef(db);
  latest.current = db;
  const act = useRef({ apply, actions });
  act.current = { apply, actions };

  const running = useRef(false);

  useEffect(() => {
    const tick = async () => {
      if (running.current) return;
      const cur = latest.current;
      if (cur.settings.propertyAutoRefresh === false) return;

      const key = cur.settings.rentcastApiKey?.trim();
      if (!key) return;

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
        recordRun(act.current.apply, "rentcast", "month", {});
      } catch (err) {
        recordRun(act.current.apply, "rentcast", "month", { error: reason(err, "The valuation failed.") });
        // The attempt is already stamped, so a bad address waits its full turn
        // rather than being retried immediately. Nothing is said out loud:
        // this runs unattended and a toast for it would only ever interrupt.
      } finally {
        running.current = false;
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), CHECK_MS);
    return () => window.clearInterval(id);
  }, []);

  return null;
}
